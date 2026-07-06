# PromptBin permissions

## Extension permissions

### `storage`

This permission saves your PromptBin preferences, including how prompt shortcuts expand and whether backup reminders are shown. These settings stay in your browser so PromptBin remembers your choices between sessions.

### `tabs`

This permission lets PromptBin find supported AI chat pages that are already open and apply settings changes to them immediately. It also allows the extension popup to open PromptBin's settings page in a new tab.

### `unlimitedStorage`

This permission gives PromptBin enough local space to hold a large library of saved prompts. It prevents the browser's standard extension storage limit from stopping you as your prompt collection grows.

## Host permissions

Host permissions allow PromptBin to detect shortcuts and insert saved prompts on supported AI chat websites, including ChatGPT, Claude, Perplexity, DeepSeek, Grok, Microsoft Copilot, and Google Gemini. They are needed because browsers do not allow extensions to read or update a website's message box without explicit access to that site.
