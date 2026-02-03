/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http:
 *
 * Copyright (c) 2026 Andrea Marchesini
 */


import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";

export interface AIMessage {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
}

export interface AITool {
  name: string;
  description: string;
  input_schema: any;
}

export interface AIAdapter {
  sendMessage(
    messages: AIMessage[],
    tools: AITool[],
    systemPrompt: string,
    onEvent: (event: AIEvent) => void
  ): Promise<void>;
}

export type AIEvent =
  | { type: "message_start" }
  | { type: "message_update"; content: any[] }
  | { type: "tool_use"; toolCall: ToolCall }
  | { type: "tool_result"; toolCall: ToolCall; result: any }
  | { type: "message_complete"; content: string }
  | { type: "error"; error: string };

export interface ToolCall {
  id: string;
  name: string;
  input: any;
}

export class AnthropicAdapter implements AIAdapter {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true
    });
  }

  async sendMessage(
    messages: AIMessage[],
    tools: AITool[],
    systemPrompt: string,
    onEvent: (event: AIEvent) => void
  ): Promise<void> {
    try {
      onEvent({ type: "message_start" });

      const response = await this.client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages.map(m => ({
          role: m.role as "user" | "assistant",
          content: m.content || ""
        })),
        tools: tools.length > 0 ? tools : undefined
      });

      let textContent = "";
      const toolCalls: ToolCall[] = [];

      for (const block of response.content) {
        if (block.type === "text") {
          textContent += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            name: block.name,
            input: block.input
          });
        }
      }

      if (textContent) {
        onEvent({
          type: "message_update",
          content: [{ type: "text", text: textContent }]
        });
      }

      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          onEvent({ type: "tool_use", toolCall });
        }
      } else {
        onEvent({ type: "message_complete", content: textContent });
      }
    } catch (error: any) {
      onEvent({
        type: "error",
        error: error.message || "Unknown error occurred"
      });
    }
  }
}

export class OpenAIAdapter implements AIAdapter {
  private client: OpenAI;
  private model: string;
  private toolNameMap: Map<string, string> = new Map();

  constructor(apiKey: string, model: string = "gpt-4", baseURL?: string) {
    this.client = new OpenAI({
      apiKey,
      dangerouslyAllowBrowser: true,
      ...(baseURL && { baseURL })
    });
    this.model = model;
  }

  private normalizeToolName(name: string): string {
    return name.replace(/\./g, "_");
  }

  async sendMessage(
    messages: AIMessage[],
    tools: AITool[],
    systemPrompt: string,
    onEvent: (event: AIEvent) => void
  ): Promise<void> {
    try {
      onEvent({ type: "message_start" });

      this.toolNameMap.clear();
      const openaiTools: OpenAI.Chat.ChatCompletionTool[] | undefined =
        tools.length > 0
          ? tools.map(t => {
              const normalizedName = this.normalizeToolName(t.name);
              this.toolNameMap.set(normalizedName, t.name);
              return {
                type: "function" as const,
                function: {
                  name: normalizedName,
                  description: t.description,
                  parameters: t.input_schema
                }
              };
            })
          : undefined;

      const openaiMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...messages.map(m => {
          if (m.role === "tool") {
            return {
              role: "tool" as const,
              content: m.content || "",
              tool_call_id: m.tool_call_id!
            };
          } else if (m.role === "assistant" && m.tool_calls) {
            return {
              role: "assistant" as const,
              content: m.content,
              tool_calls: m.tool_calls
            };
          } else {
            return {
              role: m.role as "user" | "assistant",
              content: m.content || ""
            };
          }
        })
      ];

      const stream = await this.client.chat.completions.create({
        model: this.model,
        messages: openaiMessages,
        tools: openaiTools,
        stream: true
      });

      let accumulatedContent = "";
      let toolCalls: any[] = [];

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;

        if (!delta) continue;

        if (delta.content) {
          accumulatedContent += delta.content;
          onEvent({
            type: "message_update",
            content: [{ type: "text", text: accumulatedContent }]
          });
        }

        if (delta.tool_calls) {
          for (const toolCallDelta of delta.tool_calls) {
            const index = toolCallDelta.index;

            if (!toolCalls[index]) {
              toolCalls[index] = {
                id: toolCallDelta.id || "",
                type: "function",
                function: {
                  name: "",
                  arguments: ""
                }
              };
            }

            if (toolCallDelta.id) {
              toolCalls[index].id = toolCallDelta.id;
            }
            if (toolCallDelta.function?.name) {
              toolCalls[index].function.name += toolCallDelta.function.name;
            }
            if (toolCallDelta.function?.arguments) {
              toolCalls[index].function.arguments += toolCallDelta.function.arguments;
            }
          }
        }
      }

      if (toolCalls.length > 0) {
        for (const toolCall of toolCalls) {
          const originalName = this.toolNameMap.get(toolCall.function.name) || toolCall.function.name;

          onEvent({
            type: "tool_use",
            toolCall: {
              id: toolCall.id,
              name: originalName,
              input: JSON.parse(toolCall.function.arguments)
            }
          });
        }
      } else {
        onEvent({ type: "message_complete", content: accumulatedContent });
      }
    } catch (error: any) {
      onEvent({
        type: "error",
        error: error.message || "Unknown error occurred"
      });
    }
  }
}

export class GoogleAdapter implements AIAdapter {
  private client: GoogleGenerativeAI;
  private model: string;

  constructor(apiKey: string, model: string = "gemini-pro") {
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }

  async sendMessage(
    messages: AIMessage[],
    tools: AITool[],
    systemPrompt: string,
    onEvent: (event: AIEvent) => void
  ): Promise<void> {
    try {
      onEvent({ type: "message_start" });

      const model = this.client.getGenerativeModel({
        model: this.model,
        systemInstruction: systemPrompt
      });

      const history = messages.slice(0, -1).map(m => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.content || "" }]
      }));

      const lastMessage = messages[messages.length - 1];

      const chat = model.startChat({ history });
      const result = await chat.sendMessage(lastMessage.content || "");
      const response = result.response;
      const text = response.text();

      onEvent({
        type: "message_update",
        content: [{ type: "text", text }]
      });

      onEvent({ type: "message_complete", content: text });
    } catch (error: any) {
      onEvent({
        type: "error",
        error: error.message || "Unknown error occurred"
      });
    }
  }
}

export function createAdapter(provider: string, apiKey: string, model?: string, baseURL?: string): AIAdapter {
  switch (provider) {
    case "anthropic":
      return new AnthropicAdapter(apiKey);
    case "openai":
      return new OpenAIAdapter(apiKey, model, baseURL);
    case "google":
      return new GoogleAdapter(apiKey, model);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
