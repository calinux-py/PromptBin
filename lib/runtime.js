const DEFAULT_ERROR_MESSAGE = "PromptBin request failed.";

export async function sendRequest(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, payload });

  if (!response?.ok) {
    throw new Error(response?.error ?? DEFAULT_ERROR_MESSAGE);
  }

  return response.data;
}
