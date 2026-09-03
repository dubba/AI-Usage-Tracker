import type { SVGProps } from "react";
import { OPENAI_MARK_DATA_URI } from "../openai-mark";
import type { Provider } from "../types";

type ProviderIconProps = SVGProps<SVGSVGElement> & {
  provider: Provider;
};

export function ProviderIcon({ provider, className, ...props }: ProviderIconProps) {
  if (provider === "openai") {
    return (
      <img
        src={OPENAI_MARK_DATA_URI}
        aria-label="GPT/Codex"
        role="img"
        className={`provider-icon-image${className ? ` ${className}` : ""}`}
        draggable={false}
      />
    );
  }

  if (provider === "anthropic") {
    return (
      <svg viewBox="0 0 24 24" aria-label="Anthropic" role="img" className={className} {...props}>
        <path fill="currentColor" d="M4.2 19 10 4h3.4l5.8 15h-3.4l-1.3-3.6H8.7L7.4 19H4.2Zm5.5-6.4h3.8L11.6 7l-1.9 5.6ZM19.2 4H22v15h-2.8V4Z" />
      </svg>
    );
  }

  if (provider === "antigravity" || provider === "google_ai_studio") {
    return (
      <svg viewBox="0 0 24 24" aria-label="Google" role="img" className={className} {...props}>
        <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.4-.2-2H12v3.8h5.4a4.7 4.7 0 0 1-2 3v2.5h3.2c1.9-1.8 3-4.3 3-7.3Z" />
        <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.5L15.4 17c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.2H3.1v2.6A10 10 0 0 0 12 22Z" />
        <path fill="#FBBC05" d="M6.4 13.8A6 6 0 0 1 6.1 12c0-.6.1-1.2.3-1.8V7.6H3.1A10 10 0 0 0 2 12c0 1.6.4 3.1 1.1 4.4l3.3-2.6Z" />
        <path fill="#EA4335" d="M12 6c1.5 0 2.8.5 3.8 1.5l2.9-2.8A9.7 9.7 0 0 0 12 2a10 10 0 0 0-8.9 5.6l3.3 2.6C7.2 7.8 9.4 6 12 6Z" />
      </svg>
    );
  }

  if (provider === "grok") {
    return (
      <svg viewBox="0 0 24 24" aria-label="Grok/Cursor" role="img" className={className} {...props}>
        <path
          fill="currentColor"
          d="M4.2 4.4h4.2l3.8 5.1 4.3-5.1h3.3l-6 7.1 6.1 8.1h-4.2l-4.1-5.6-4.8 5.6H3.5l6.5-7.6-5.8-7.6Zm4.7 2.2 7.4 10.8h1.5L10.4 6.6H8.9Z"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-label="OpenCode" role="img" className={className} {...props}>
      <rect x="2.5" y="3.5" width="19" height="17" rx="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="m7 9 3 3-3 3M12.5 15H17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
