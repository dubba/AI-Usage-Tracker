import type { FieldsProps } from "./types";

export function GoogleAiStudioFields({
  draft,
  update,
  setError,
  busy,
  modelsBusy,
  onLoadModels,
}: FieldsProps & { modelsBusy: boolean; onLoadModels: () => void }) {
  const { availableModels, selectedModels } = draft;
  return (
    <>
      <label className="field-label field-spaced" htmlFor="google-ai-studio-key">Google AI Studio API key</label>
      <div className="google-key-row">
        <input
          id="google-ai-studio-key"
          className="text-input"
          type="password"
          value={draft.apiKey}
          onChange={(event) => {
            update({ apiKey: event.target.value, availableModels: [], selectedModels: [] });
            setError(null);
          }}
          placeholder="Paste the API key"
          autoComplete="off"
          spellCheck={false}
          disabled={busy || modelsBusy}
        />
        <button
          type="button"
          className="button ghost google-load-models"
          onClick={onLoadModels}
          disabled={busy || modelsBusy || !draft.apiKey.trim()}
        >
          {modelsBusy ? "Loading…" : availableModels.length ? "Reload models" : "Load models"}
        </button>
      </div>
      <div className="credential-note">The key is sent only to the Rust backend and saved in Credential Manager or Keychain after you add the account.</div>

      {availableModels.length ? (
        <div className="google-model-picker">
          <div className="google-model-picker-header">
            <div>
              <strong>Models to track</strong>
              <small>{selectedModels.length} of {availableModels.length} selected</small>
            </div>
            <div className="google-model-picker-actions">
              <button type="button" onClick={() => update({ selectedModels: availableModels.map((model) => model.name) })} disabled={busy}>Select all</button>
              <button type="button" onClick={() => update({ selectedModels: [] })} disabled={busy || !selectedModels.length}>Clear</button>
            </div>
          </div>
          <div className="google-model-list">
            {availableModels.map((model) => (
              <label className="google-model-option" key={model.name}>
                <input
                  type="checkbox"
                  checked={selectedModels.includes(model.name)}
                  disabled={busy}
                  onChange={(event) => {
                    update({
                      selectedModels: event.target.checked
                        ? [...selectedModels, model.name]
                        : selectedModels.filter((name) => name !== model.name),
                    });
                    setError(null);
                  }}
                />
                <span>
                  <strong>{model.label}</strong>
                  <small>{model.name}</small>
                </span>
              </label>
            ))}
          </div>
          <div className="credential-note google-usage-note">The API key confirms model access. Project-level RPM, TPM, and daily quotas require the separate read-only Google Cloud connection available on the account card.</div>
        </div>
      ) : null}
    </>
  );
}
