import { DevicesIcon, PlusIcon, UsersIcon } from "../../shared/ui/icons";
import { ProviderIcon } from "../../shared/ui/ProviderIcon";
import type { Provider } from "../../types";

/** First-run cards. Brand on top, product underneath — Google's product is Antigravity, not AI Studio. */
const EMPTY_STATE_PROVIDERS: { provider: Provider; brand: string; product: string }[] = [
  { provider: "anthropic", brand: "Anthropic", product: "Claude" },
  { provider: "antigravity", brand: "Google", product: "Antigravity" },
  { provider: "openai", brand: "OpenAI", product: "ChatGPT" },
  { provider: "grok", brand: "xAI", product: "Grok" },
];

export const EMPTY_ACCOUNT_DESCRIPTION = "Add an account to see how much of its weekly limit you use each day.";

/** Dashboard empty state. The Usage page uses `EMPTY_ACCOUNT_DESCRIPTION`. */
export const DASHBOARD_EMPTY_ACCOUNT_DESCRIPTION = "Add an account to begin monitoring its usage limits.";

/** The first-run card: a provider to connect, or another provider, or linking a device. */
export function EmptyAccountPanel({
  description = EMPTY_ACCOUNT_DESCRIPTION,
  onAdd,
  onOpenPairing,
}: {
  description?: string;
  onAdd: (provider?: Provider) => void;
  onOpenPairing?: () => void;
}) {
  return (
    <section className="welcome-panel mockup-empty-panel">
      <UsersIcon />
      <h2>Connect an AI Account</h2>
      <p>{description}</p>
      <div className="empty-group-actions">
        <div className="empty-provider-grid">
          {EMPTY_STATE_PROVIDERS.map(({ provider, brand, product }) => (
            <button
              key={provider}
              type="button"
              className="empty-provider-card"
              aria-label={`Add ${brand} ${product}`}
              onClick={() => onAdd(provider)}
            >
              <span className={`empty-provider-mark provider-${provider}`}>
                <ProviderIcon provider={provider} />
              </span>
              <span className="empty-provider-brand">{brand}</span>
              <span className="empty-provider-product">{product}</span>
            </button>
          ))}
          <div className="empty-provider-actions">
            <button
              type="button"
              className="button ghost empty-provider-other"
              aria-label="Other Provider"
              onClick={() => onAdd("opencode_go")}
            >
              <PlusIcon />
              <span>Other</span>
            </button>
            {onOpenPairing ? (
              <button type="button" className="button ghost empty-provider-other" onClick={onOpenPairing}>
                <DevicesIcon className="settings-update-action-icon" />
                <span>Link Devices</span>
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
