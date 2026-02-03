/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http:
 *
 * Copyright (c) 2026 Andrea Marchesini
 */

import { createAdapter, type AIAdapter, type AIEvent, type AIMessage, type AITool, type ToolCall } from "./ai-adapter";
import { PermissionManager, type PermissionRequestMessage, type PermissionResponseMessage } from "aikit-common";

interface ToolRegistration {
  extensionId: string;
  tools: ToolDescriptor[];
}

interface ToolDescriptor {
  name: string;
  label: string;
  description: string;
  parameters: any;
}

interface ToolExecutionRequest {
  type: "TOOL_EXECUTE";
  toolName: string;
  params: any;
  toolCallId: string;
}

interface ToolExecutionResponse {
  content: any[];
  details?: any;
  error?: string;
}

interface MessageFromSidebar {
  type: string;
  apiKey?: string;
  provider?: string;
  model?: string;
  prompt?: string;
}

interface MessageFromPort {
  type: string;
  prompt?: string;
}

class ToolRegistry {
  private registeredTools: Map<string, { extensionId: string; descriptor: ToolDescriptor }> = new Map();
  private adapter: AIAdapter | null = null;
  private conversationHistory: AIMessage[] = [];
  private permissionManager: PermissionManager = new PermissionManager();
  private connectedPorts: Set<browser.runtime.Port> = new Set();
  private pendingPermissionRequests: Map<string, { resolve: (granted: boolean) => void; reject: (error: Error) => void }> = new Map();

  private normalizeToolName(name: string): string {
    return name.replace(/\./g, "_");
  }

  registerExtension(extensionId: string, tools: ToolDescriptor[]) {
    console.log(`Registering tools from extension: ${extensionId}`, tools);

    for (const tool of tools) {
      this.registeredTools.set(tool.name, { extensionId, descriptor: tool });
    }

    console.log(`Registered ${tools.length} tools from ${extensionId}`);
  }

  unregisterExtension(extensionId: string) {
    console.log(`Unregistering extension: ${extensionId}`);

    for (const [toolName, registration] of this.registeredTools.entries()) {
      if (registration.extensionId === extensionId) {
        this.registeredTools.delete(toolName);
      }
    }
  }

  private getAITools(): AITool[] {
    const tools: AITool[] = [];

    for (const [toolName, registration] of this.registeredTools.entries()) {
      tools.push({
        name: registration.descriptor.name,
        description: registration.descriptor.description,
        input_schema: registration.descriptor.parameters
      });
    }

    return tools;
  }

  async initializeAdapter(apiKey: string, provider: string = "anthropic", model: string = "claude-sonnet-4-20250514", baseURL?: string) {
    try {
      this.adapter = createAdapter(provider, apiKey, model, baseURL);
      console.log("AI adapter initialized successfully");
      return true;
    } catch (error) {
      console.error("Failed to initialize adapter:", error);
      throw error;
    }
  }

  async executePrompt(prompt: string, onEvent: (event: AIEvent) => void): Promise<void> {
    if (!this.adapter) {
      throw new Error("Adapter not initialized. Please configure API key first.");
    }

    this.conversationHistory.push({
      role: "user",
      content: prompt,
      tool_calls: undefined,
      tool_call_id: undefined
    });

    const tools = this.getAITools();
    const systemPrompt = "You are a helpful AI assistant that can control the browser using available tools. When the user asks you to perform an action, use the appropriate tools to accomplish it. Be concise and helpful.";

    let continueConversation = true;
    let pendingToolCalls: ToolCall[] = [];

    while (continueConversation) {
      continueConversation = false;
      pendingToolCalls = [];

      await this.adapter.sendMessage(
        this.conversationHistory,
        tools,
        systemPrompt,
        async (event) => {
          if (event.type === "tool_use") {
            pendingToolCalls.push(event.toolCall);

            onEvent({
              type: "tool_use",
              toolCall: event.toolCall
            });
          } else {
            onEvent(event);

            if (event.type === "message_complete") {
              this.conversationHistory.push({
                role: "assistant",
                content: event.content,
                tool_calls: undefined,
                tool_call_id: undefined
              });
            }
          }
        }
      );

      if (pendingToolCalls.length > 0) {
        const openAIToolCalls = pendingToolCalls.map(tc => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: this.normalizeToolName(tc.name),
            arguments: JSON.stringify(tc.input)
          }
        }));

        this.conversationHistory.push({
          role: "assistant",
          content: null,
          tool_calls: openAIToolCalls,
          tool_call_id: undefined
        });

        for (const toolCall of pendingToolCalls) {
          const result = await this.executeTool(toolCall);

          onEvent({
            type: "tool_result",
            toolCall: toolCall,
            result
          });

          const resultText = result.content
            ?.map((c: any) => c.text)
            .join(" ") || "Tool executed";

          this.conversationHistory.push({
            role: "tool",
            content: resultText,
            tool_calls: undefined,
            tool_call_id: toolCall.id
          });
        }

        continueConversation = true;
      }
    }
  }

  private async executeTool(toolCall: ToolCall): Promise<ToolExecutionResponse> {
    const registration = this.registeredTools.get(toolCall.name);

    if (!registration) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${toolCall.name}` }],
        error: `Unknown tool: ${toolCall.name}`
      };
    }

    const context = await this.getToolContext(toolCall.name);

    const permissionCheck = await this.permissionManager.checkPermission(
      toolCall.name,
      { ...context, toolDescriptor: registration.descriptor }
    );

    if (!permissionCheck.allowed && !permissionCheck.requiresPrompt) {
      return {
        content: [{ type: "text", text: `Permission denied for tool: ${toolCall.name}` }],
        error: "Permission denied"
      };
    }

    if (permissionCheck.requiresPrompt) {
      const granted = await this.requestPermissionFromUser(
        toolCall,
        registration.descriptor,
        context
      );

      if (!granted) {
        return {
          content: [{ type: "text", text: `User denied permission for tool: ${toolCall.name}` }],
          error: "User denied permission"
        };
      }
    }

    try {
      const response = await browser.runtime.sendMessage(
        registration.extensionId,
        {
          type: "TOOL_EXECUTE",
          toolName: toolCall.name,
          params: toolCall.input,
          toolCallId: toolCall.id
        } as ToolExecutionRequest
      ) as ToolExecutionResponse;

      if (response.error) {
        return {
          content: [{ type: "text", text: `Error: ${response.error}` }],
          error: response.error
        };
      }

      return response;
    } catch (error: any) {
      console.error(`Error executing tool ${toolCall.name}:`, error);
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        error: error.message
      };
    }
  }

  private async getToolContext(toolName: string): Promise<{ url?: string; tabId?: number }> {
    if (!this.permissionManager.isDomainAwareTool(toolName)) {
      return {};
    }

    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs[0]) {
        return {
          url: tabs[0].url,
          tabId: tabs[0].id
        };
      }
    } catch (error) {
      console.error("Failed to get tab context:", error);
    }

    return {};
  }

  private async requestPermissionFromUser(
    toolCall: ToolCall,
    descriptor: ToolDescriptor,
    context: { url?: string; tabId?: number }
  ): Promise<boolean> {
    const requestId = `perm-${Date.now()}-${Math.random()}`;

    const request: PermissionRequestMessage = {
      type: "PERMISSION_REQUEST",
      toolName: toolCall.name,
      toolDescriptor: descriptor,
      params: toolCall.input,
      context,
      requestId
    };

    for (const port of this.connectedPorts) {
      port.postMessage(request);
    }

    return new Promise((resolve, reject) => {
      this.pendingPermissionRequests.set(requestId, {
        resolve,
        reject,
        toolName: toolCall.name,
        domain: context.url ? this.permissionManager.extractDomain(context.url) : undefined
      } as any);

      setTimeout(() => {
        if (this.pendingPermissionRequests.has(requestId)) {
          this.pendingPermissionRequests.delete(requestId);
          reject(new Error("Permission request timeout"));
        }
      }, 60000);
    });
  }

  handlePermissionResponse(response: PermissionResponseMessage): void {
    const pending = this.pendingPermissionRequests.get(response.requestId) as any;

    if (!pending) {
      console.warn("No pending permission request for:", response.requestId);
      return;
    }

    this.pendingPermissionRequests.delete(response.requestId);

    if (response.granted && response.remember) {
      const decision = "always_allow";
      const domain = response.scope === "domain" ? pending.domain : undefined;

      this.permissionManager.storePermission(pending.toolName, decision, domain).catch((error: any) => {
        console.error("Failed to store permission:", error);
      });
    } else if (!response.granted && response.remember) {
      const decision = "always_deny";
      const domain = response.scope === "domain" ? pending.domain : undefined;

      this.permissionManager.storePermission(pending.toolName, decision, domain).catch((error: any) => {
        console.error("Failed to store permission:", error);
      });
    }

    pending.resolve(response.granted);
  }

  getRegisteredTools() {
    return Array.from(this.registeredTools.entries()).map(([name, registration]) => ({
      name,
      extensionId: registration.extensionId,
      descriptor: registration.descriptor
    }));
  }

  async allowAllTools(): Promise<void> {
    for (const [toolName] of this.registeredTools.entries()) {
      await this.permissionManager.storePermission(toolName, "always_allow");
    }
  }
}

const toolRegistry = new ToolRegistry();

browser.runtime.onMessageExternal.addListener((message, sender) => {
  console.log("Received message from external extension:", message, sender);

  if (!sender.id) {
    return;
  }

  switch (message.type) {
    case "REGISTER_TOOLS":
      toolRegistry.registerExtension(sender.id, message.tools);
      return Promise.resolve({ success: true });

    case "UNREGISTER_TOOLS":
      toolRegistry.unregisterExtension(sender.id);
      return Promise.resolve({ success: true });

    default:
      console.warn("Unknown message type:", message.type);
  }
});

browser.runtime.onMessage.addListener((message: any, sender) => {
  console.log("Received message from sidebar:", message);

  switch (message.type) {
    case "INIT_AGENT":
      if (message.apiKey && message.provider) {
        return toolRegistry.initializeAdapter(
          message.apiKey,
          message.provider,
          message.model,
          message.baseURL
        );
      }
      return Promise.resolve({ success: false, error: "Missing parameters" });

    case "GET_TOOLS":
      return Promise.resolve({ tools: toolRegistry.getRegisteredTools() });

    case "PERMISSION_RESPONSE":
      toolRegistry.handlePermissionResponse(message as PermissionResponseMessage);
      return Promise.resolve({ success: true });

    case "GET_PERMISSIONS":
      return toolRegistry["permissionManager"].getGrantedPermissions();

    case "REVOKE_PERMISSION":
      return toolRegistry["permissionManager"].revokePermission(
        message.toolName,
        message.domain
      ).then(() => ({ success: true }));

    case "ALLOW_ALL_TOOLS":
      return toolRegistry.allowAllTools().then(() => ({ success: true }));

    case "SET_AUTO_APPROVE":
      return toolRegistry["permissionManager"].setAutoApprove(message.enabled)
        .then(() => ({ success: true }));

    case "GET_AUTO_APPROVE":
      return toolRegistry["permissionManager"].getAutoApprove()
        .then(enabled => ({ enabled }));

    default:
      console.warn("Unknown message type:", message.type);
  }
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name === "agent-stream") {
    toolRegistry["connectedPorts"].add(port);

    port.onDisconnect.addListener(() => {
      toolRegistry["connectedPorts"].delete(port);
    });

    port.onMessage.addListener(async (msg: any) => {
      const message = msg as MessageFromPort;
      if (message.type === "EXECUTE_PROMPT" && message.prompt) {
        try {
          await toolRegistry.executePrompt(message.prompt, (event) => {
            port.postMessage({ type: "AGENT_EVENT", event });
          });
          port.postMessage({ type: "AGENT_COMPLETE" });
        } catch (error: any) {
          port.postMessage({
            type: "AGENT_ERROR",
            error: error.message || "Unknown error"
          });
        }
      }
    });
  }
});

browser.management.getAll().then(extensions => {
  extensions.forEach(ext => {
    if (ext.id !== browser.runtime.id && ext.enabled) {
      browser.runtime.sendMessage(ext.id, {
        type: "ORCHESTRATOR_READY"
      }).catch(() => {
      });
    }
  });
});

console.log("AIKit Orchestrator background script loaded");
