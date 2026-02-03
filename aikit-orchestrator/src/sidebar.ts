/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http:
 *
 * Copyright (c) 2026 Andrea Marchesini
 */

import { marked } from "marked";

marked.setOptions({
  breaks: true,
  gfm: true
});

const permissionsBtn = document.getElementById("permissionsBtn") as HTMLButtonElement;
const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
const configPanel = document.getElementById("configPanel") as HTMLDivElement;
const saveConfigBtn = document.getElementById("saveConfig") as HTMLButtonElement;
const configStatus = document.getElementById("configStatus") as HTMLDivElement;
const providerSelect = document.getElementById("provider") as HTMLSelectElement;
const modelInput = document.getElementById("model") as HTMLInputElement;
const apiKeyInput = document.getElementById("apiKey") as HTMLInputElement;
const baseURLInput = document.getElementById("baseURL") as HTMLInputElement;
const toolsPanel = document.querySelector(".tools-panel") as HTMLDivElement;
const toolsHeader = document.getElementById("toolsHeader") as HTMLHeadingElement;
const toolsList = document.getElementById("toolsList") as HTMLDivElement;
const toolCount = document.getElementById("toolCount") as HTMLSpanElement;
const chatContainer = document.querySelector(".chat-container") as HTMLDivElement;
const messagesDiv = document.getElementById("messages") as HTMLDivElement;
const promptInput = document.getElementById("promptInput") as HTMLTextAreaElement;
const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
const stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
const statusBar = document.getElementById("statusBar") as HTMLDivElement;
const statusText = document.getElementById("statusText") as HTMLDivElement;
const permissionModal = document.getElementById("permissionModal") as HTMLDivElement;
const permToolName = document.getElementById("permToolName") as HTMLDivElement;
const permToolDescription = document.getElementById("permToolDescription") as HTMLDivElement;
const permDomainSection = document.getElementById("permDomainSection") as HTMLDivElement;
const permDomain = document.getElementById("permDomain") as HTMLDivElement;
const permParams = document.getElementById("permParams") as HTMLPreElement;
const permRemember = document.getElementById("permRemember") as HTMLInputElement;
const permScopeOptions = document.getElementById("permScopeOptions") as HTMLDivElement;
const permScopeDomain = document.getElementById("permScopeDomain") as HTMLSpanElement;
const permDenyBtn = document.getElementById("permDenyBtn") as HTMLButtonElement;
const permAllowBtn = document.getElementById("permAllowBtn") as HTMLButtonElement;

let agentPort: browser.runtime.Port | null = null;
let isAgentInitialized = false;
let isProcessing = false;
let currentPermissionRequest: any = null;

permissionsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
});

settingsBtn.addEventListener("click", () => {
  configPanel.classList.toggle("hidden");
});

providerSelect.addEventListener("change", updateBaseURLVisibility);

toolsHeader.addEventListener("click", () => {
  toolsPanel.classList.toggle("collapsed");
  const isCollapsed = toolsPanel.classList.contains("collapsed");
  browser.storage.local.set({ toolsPanelCollapsed: isCollapsed });
});

async function loadToolsPanelState() {
  const state = await browser.storage.local.get("toolsPanelCollapsed");
  if (state.toolsPanelCollapsed) {
    toolsPanel.classList.add("collapsed");
  }
}

loadToolsPanelState();

function updateBaseURLVisibility() {
  const baseURLGroup = baseURLInput.parentElement as HTMLElement;
  if (providerSelect.value === "openai") {
    baseURLGroup.style.display = "block";
  } else {
    baseURLGroup.style.display = "none";
  }
}

async function loadConfig() {
  const config = await browser.storage.local.get(["provider", "model", "apiKey", "baseURL"]);
  if (config.provider) providerSelect.value = config.provider;
  if (config.model) modelInput.value = config.model;
  if (config.baseURL) baseURLInput.value = config.baseURL;
  if (config.apiKey) {
    apiKeyInput.value = config.apiKey;
    await initializeAgent();
  }
  updateBaseURLVisibility();
}

saveConfigBtn.addEventListener("click", async () => {
  const provider = providerSelect.value;
  const model = modelInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const baseURL = baseURLInput.value.trim();

  if (!apiKey) {
    showStatus("Please enter an API key", "error");
    return;
  }

  if (!model) {
    showStatus("Please enter a model name", "error");
    return;
  }

  await browser.storage.local.set({ provider, model, apiKey, baseURL });

  showStatus("Initializing agent...", "success");

  try {
    await initializeAgent();
    showStatus("Agent initialized successfully!", "success");
    setTimeout(() => {
      configPanel.classList.add("hidden");
    }, 1500);
  } catch (error: any) {
    showStatus(`Error: ${error.message}`, "error");
  }
});

async function initializeAgent() {
  const config = await browser.storage.local.get(["provider", "model", "apiKey", "baseURL"]);

  try {
    const message: any = {
      type: "INIT_AGENT",
      provider: config.provider || "anthropic",
      model: config.model || "claude-sonnet-4-20250514",
      apiKey: config.apiKey
    };

    if (config.provider === "openai" && config.baseURL) {
      message.baseURL = config.baseURL;
    }

    const response = await browser.runtime.sendMessage(message);

    if (response) {
      isAgentInitialized = true;
      connectAgentStream();
      await updateToolsList();
    }
  } catch (error: any) {
    throw new Error(`Failed to initialize agent: ${error.message}`);
  }
}

function connectAgentStream() {
  agentPort = browser.runtime.connect({ name: "agent-stream" });

  agentPort.onMessage.addListener((msg: any) => {
    const message = msg as { type: string; event?: any; error?: string };
    switch (message.type) {
      case "AGENT_EVENT":
        handleAgentEvent(message.event);
        break;
      case "AGENT_COMPLETE":
        isProcessing = false;
        sendBtn.classList.remove("hidden");
        stopBtn.classList.add("hidden");
        removeTypingIndicator();
        hideStatusBar();
        break;
      case "AGENT_ERROR":
        isProcessing = false;
        sendBtn.classList.remove("hidden");
        stopBtn.classList.add("hidden");
        removeTypingIndicator();
        hideStatusBar();
        addMessage(`Error: ${message.error}`, "error");
        break;
      case "PERMISSION_REQUEST":
        showPermissionModal(message as any);
        break;
    }
  });

  agentPort.onDisconnect.addListener(() => {
    isProcessing = false;
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    removeTypingIndicator();
    hideStatusBar();
  });
}

async function updateToolsList() {
  try {
    const response = await browser.runtime.sendMessage({ type: "GET_TOOLS" });
    const tools = response.tools || [];

    toolCount.textContent = tools.length.toString();
    toolsList.innerHTML = "";

    if (tools.length === 0) {
      toolsList.innerHTML = '<div style="color: #999; font-size: 11px;">No tools registered yet</div>';
    } else {
      tools.forEach((tool: any) => {
        const tag = document.createElement("div");
        tag.className = "tool-tag";
        tag.textContent = tool.name;
        tag.title = tool.descriptor.description;
        toolsList.appendChild(tag);
      });
    }
  } catch (error) {
    console.error("Failed to update tools list:", error);
  }
}

sendBtn.addEventListener("click", sendPrompt);
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

async function sendPrompt() {
  const prompt = promptInput.value.trim();

  if (!prompt) return;

  if (!isAgentInitialized) {
    addMessage("Please configure the API key first", "error");
    configPanel.classList.remove("hidden");
    return;
  }

  if (isProcessing) return;

  addMessage(prompt, "user");
  promptInput.value = "";

  showTypingIndicator();

  isProcessing = true;
  sendBtn.classList.add("hidden");
  stopBtn.classList.remove("hidden");

  if (agentPort) {
    agentPort.postMessage({
      type: "EXECUTE_PROMPT",
      prompt
    });
  }
}

function stopExecution() {
  if (agentPort && isProcessing) {
    agentPort.disconnect();
    agentPort = null;
    isProcessing = false;
    sendBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    removeTypingIndicator();
    hideStatusBar();
    addMessage("Execution stopped by user", "system");

    connectAgentStream();
  }
}

stopBtn.addEventListener("click", stopExecution);

function handleAgentEvent(event: any) {
  console.log("Agent event:", event);

  switch (event.type) {
    case "message_start":
      removeTypingIndicator();
      updateStatusBar("Thinking...");
      break;

    case "message_update":
      updateAssistantMessage(event.content);
      break;

    case "message_complete":
      updateAssistantMessage([{ type: "text", text: event.content }]);
      hideStatusBar();
      break;

    case "tool_use":
      console.log("Tool executing:", event.toolCall.name);
      const toolName = event.toolCall.name;
      const params = event.toolCall.input;
      updateStatusBar(`Using ${toolName}...`);
      addToolMessage(toolName, "executing", params);
      break;

    case "tool_result":
      console.log("Tool completed:", event.toolCall.name);
      updateToolMessage(event.toolCall.name, "completed", event.result);
      break;

    case "error":
      hideStatusBar();
      addMessage(`Error: ${event.error}`, "error");
      break;
  }
}

let currentAssistantMessageId: string | null = null;

function updateAssistantMessage(content: any[]) {
  const textContent = content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");

  if (!textContent) return;

  if (!currentAssistantMessageId) {
    currentAssistantMessageId = addMessage(textContent, "assistant");
  } else {
    const messageEl = document.querySelector(`[data-message-id="${currentAssistantMessageId}"]`);
    if (messageEl) {
      messageEl.innerHTML = marked.parse(textContent) as string;
    }
  }

  scrollToBottom();
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  });
}

function addMessage(text: string, type: "user" | "assistant" | "system" | "error"): string {
  const messageId = `msg-${Date.now()}-${Math.random()}`;
  const messageEl = document.createElement("div");
  messageEl.className = `message ${type}`;
  messageEl.setAttribute("data-message-id", messageId);

  if (type === "assistant") {
    messageEl.innerHTML = marked.parse(text) as string;
  } else {
    messageEl.textContent = text;
  }

  messagesDiv.appendChild(messageEl);
  scrollToBottom();

  if (type === "assistant") {
    currentAssistantMessageId = messageId;
  }

  return messageId;
}

function showTypingIndicator() {
  const indicator = document.createElement("div");
  indicator.className = "message assistant typing-indicator";
  indicator.id = "typing-indicator";
  indicator.innerHTML = "<span></span><span></span><span></span>";
  messagesDiv.appendChild(indicator);
  updateStatusBar("Processing...");
  scrollToBottom();
}

function removeTypingIndicator() {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) {
    indicator.remove();
  }
  currentAssistantMessageId = null;
}

function updateStatusBar(text: string) {
  statusText.textContent = text;
  statusBar.classList.remove("hidden");
}

function hideStatusBar() {
  statusBar.classList.add("hidden");
}

let toolMessageMap = new Map<string, string>();

function addToolMessage(toolName: string, status: "executing" | "completed", data?: any) {
  const messageId = `tool-${toolName}-${Date.now()}`;
  const messageEl = document.createElement("div");
  messageEl.className = "message tool";
  messageEl.setAttribute("data-tool-message-id", messageId);
  messageEl.setAttribute("data-tool-name", toolName);

  const statusIcon = status === "executing" ? "⏳" : "✓";
  const statusText = status === "executing" ? "executing" : "completed";

  messageEl.innerHTML = `
    <span class="tool-badge">${toolName}</span>
    <span class="tool-content">${statusIcon} ${statusText}</span>
  `;

  messagesDiv.appendChild(messageEl);
  toolMessageMap.set(toolName, messageId);
  scrollToBottom();
}

function updateToolMessage(toolName: string, status: "completed", result: any) {
  const messageId = toolMessageMap.get(toolName);
  if (!messageId) return;

  const messageEl = document.querySelector(`[data-tool-message-id="${messageId}"]`);
  if (!messageEl) return;

  const resultText = result.content
    ?.filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join(" ") || "completed";

  messageEl.innerHTML = `
    <span class="tool-badge">${toolName}</span>
    <span class="tool-content">✓ ${resultText}</span>
  `;

  toolMessageMap.delete(toolName);
  scrollToBottom();
}

function addToolExecution(toolCall: any, status: "start" | "end") {
  const toolId = `tool-${toolCall.id}`;
  let toolEl = document.getElementById(toolId);

  if (!toolEl) {
    toolEl = document.createElement("div");
    toolEl.className = "tool-execution";
    toolEl.id = toolId;
    messagesDiv.appendChild(toolEl);
  }

  if (status === "start") {
    toolEl.innerHTML = `<div class="tool-name">🔧 ${toolCall.name}</div><div>Executing...</div>`;
  }

  scrollToBottom();
}

function updateToolExecution(toolCall: any, result: any) {
  const toolId = `tool-${toolCall.id}`;
  const toolEl = document.getElementById(toolId);

  if (toolEl) {
    const resultText = result.content
      ?.filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join(" ") || "Completed";

    toolEl.innerHTML = `<div class="tool-name">✅ ${toolCall.name}</div><div>${resultText}</div>`;
  }

  scrollToBottom();
}

function showStatus(message: string, type: "success" | "error") {
  configStatus.textContent = message;
  configStatus.className = `status ${type}`;

  if (type === "success") {
    setTimeout(() => {
      configStatus.style.display = "none";
    }, 3000);
  }
}

function showPermissionModal(request: any) {
  currentPermissionRequest = request;

  permToolName.textContent = request.toolName;
  permToolDescription.textContent = request.toolDescriptor.description;
  permParams.textContent = JSON.stringify(request.params, null, 2);

  if (request.context.url) {
    const domain = new URL(request.context.url).hostname;
    permDomainSection.classList.remove("hidden");
    permDomain.textContent = domain;
    permScopeDomain.textContent = domain;
  } else {
    permDomainSection.classList.add("hidden");
  }

  permRemember.checked = false;
  permScopeOptions.classList.add("hidden");

  permissionModal.classList.remove("hidden");
}

function hidePermissionModal() {
  permissionModal.classList.add("hidden");
  currentPermissionRequest = null;
}

async function handlePermissionResponse(granted: boolean) {
  if (!currentPermissionRequest) return;

  const remember = permRemember.checked;
  let scope: "global" | "domain" = "global";

  if (remember && currentPermissionRequest.context.url) {
    const scopeRadio = document.querySelector('input[name="permScope"]:checked') as HTMLInputElement;
    scope = scopeRadio?.value as "global" | "domain" || "global";
  }

  await browser.runtime.sendMessage({
    type: "PERMISSION_RESPONSE",
    requestId: currentPermissionRequest.requestId,
    granted,
    remember,
    scope: remember ? scope : undefined
  });

  const statusText = granted ? "✓ Permission granted" : "✗ Permission denied";
  addMessage(statusText, "system");

  hidePermissionModal();
}

permRemember.addEventListener("change", () => {
  if (permRemember.checked && currentPermissionRequest?.context.url) {
    permScopeOptions.classList.remove("hidden");
  } else {
    permScopeOptions.classList.add("hidden");
  }
});

permDenyBtn.addEventListener("click", () => {
  handlePermissionResponse(false);
});

permAllowBtn.addEventListener("click", () => {
  handlePermissionResponse(true);
});

loadConfig();
updateToolsList();

setInterval(updateToolsList, 5000);

console.log("Sidebar loaded");
