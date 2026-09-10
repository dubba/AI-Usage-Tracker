import { useRef, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLinkIcon } from "../icons";
import { useModalA11y } from "./useModalA11y";
import type { UpdateBusy } from "../types";

export const CHANGELOG_URL = "https://github.com/dubba/AI-Usage-Tracker/blob/main/CHANGELOG.md";

interface Block {
  type: "h2" | "h3" | "h4" | "list" | "paragraph";
  items?: string[];
  text?: string;
}

function parseMarkdownBlocks(markdown: string): Block[] {
  const lines = markdown.split(/\r?\n/);
  const blocks: Block[] = [];
  let currentList: string[] | null = null;

  const flushList = () => {
    if (currentList && currentList.length > 0) {
      blocks.push({ type: "list", items: currentList });
      currentList = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }

    if (line.startsWith("#### ")) {
      flushList();
      blocks.push({ type: "h4", text: line.slice(5).trim() });
    } else if (line.startsWith("### ")) {
      flushList();
      blocks.push({ type: "h3", text: line.slice(4).trim() });
    } else if (line.startsWith("## ") || line.startsWith("# ")) {
      flushList();
      blocks.push({ type: "h2", text: line.replace(/^#+\s*/, "").trim() });
    } else if (/^[-*•]\s+/.test(line)) {
      const bulletText = line.replace(/^[-*•]\s+/, "");
      if (!currentList) {
        currentList = [];
      }
      currentList.push(bulletText);
    } else {
      flushList();
      blocks.push({ type: "paragraph", text: line });
    }
  }

  flushList();
  return blocks;
}

interface InlineToken {
  type: "text" | "bold" | "code" | "link";
  content?: string;
  label?: string;
  url?: string;
  children?: InlineToken[];
}

function parseInlineTokens(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*(?:[^*]|\*(?!\*))+\*\*|`[^`]+`)/g;
  let match: RegExpExecArray | null;
  let lastIdx = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIdx) {
      tokens.push({ type: "text", content: text.slice(lastIdx, match.index) });
    }
    const token = match[0];
    if (token.startsWith("[") && token.includes("](")) {
      const m = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (m) {
        tokens.push({ type: "link", label: m[1], url: m[2] });
      } else {
        tokens.push({ type: "text", content: token });
      }
    } else if (token.startsWith("**") && token.endsWith("**")) {
      tokens.push({
        type: "bold",
        children: parseInlineTokens(token.slice(2, -2)),
      });
    } else if (token.startsWith("`") && token.endsWith("`")) {
      tokens.push({ type: "code", content: token.slice(1, -1) });
    }
    lastIdx = pattern.lastIndex;
  }

  if (lastIdx < text.length) {
    tokens.push({ type: "text", content: text.slice(lastIdx) });
  }

  return tokens;
}

function renderTokens(tokens: InlineToken[], parentKey = "root"): ReactNode[] {
  return tokens.map((token, index) => {
    const key = `${parentKey}-${index}`;
    if (token.type === "bold") {
      return <strong key={key}>{renderTokens(token.children ?? [], key)}</strong>;
    }
    if (token.type === "code") {
      return (
        <code key={key} className="update-notes-code">
          {token.content}
        </code>
      );
    }
    if (token.type === "link" && token.url) {
      return (
        <a
          key={key}
          href={token.url}
          className="update-notes-link"
          onClick={(e) => {
            e.preventDefault();
            void openUrl(token.url!).catch(() => {});
          }}
        >
          {token.label}
        </a>
      );
    }
    return token.content;
  });
}

function renderInline(text: string): ReactNode {
  return renderTokens(parseInlineTokens(text));
}

function formatReleaseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function UpdateNotesModal({
  open,
  version,
  releaseDate,
  releaseNotes,
  onClose,
  onInstallUpdate,
  updateBusy,
}: {
  open: boolean;
  version: string | null;
  releaseDate?: string | null;
  releaseNotes?: string | null;
  onClose: () => void;
  onInstallUpdate?: () => void;
  updateBusy?: UpdateBusy;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useModalA11y(dialogRef, open, onClose);

  if (!open) return null;

  const cleanVersion = (version || "").replace(/^v/i, "");
  const blocks = releaseNotes ? parseMarkdownBlocks(releaseNotes) : [];
  const formattedDate = formatReleaseDate(releaseDate);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        ref={dialogRef}
        className="modal-card update-notes-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-notes-title"
        tabIndex={-1}
      >
        <button
          type="button"
          className="ui-modal-close"
          data-react-close="true"
          onClick={onClose}
          aria-label="Close dialog"
          data-tooltip="Close"
        >
          ×
        </button>
        <div className="modal-kicker">App Update</div>
        <h2 id="update-notes-title">
          {cleanVersion ? `What changed in v${cleanVersion}` : "Release Changes"}
        </h2>
        {formattedDate ? (
          <p className="update-notes-subtitle">Published {formattedDate}</p>
        ) : null}

        <div className="update-notes-content">
          {blocks.length > 0 ? (
            blocks.map((block, idx) => {
              if (block.type === "h2") {
                return (
                  <h3 key={idx} className="update-notes-heading-2">
                    {renderInline(block.text || "")}
                  </h3>
                );
              }
              if (block.type === "h3") {
                return (
                  <h4 key={idx} className="update-notes-heading-3">
                    {renderInline(block.text || "")}
                  </h4>
                );
              }
              if (block.type === "h4") {
                return (
                  <h5 key={idx} className="update-notes-heading-4">
                    {renderInline(block.text || "")}
                  </h5>
                );
              }
              if (block.type === "list" && block.items) {
                return (
                  <ul key={idx} className="update-notes-list">
                    {block.items.map((item, itemIdx) => (
                      <li key={itemIdx}>{renderInline(item)}</li>
                    ))}
                  </ul>
                );
              }
              return (
                <p key={idx} className="update-notes-paragraph">
                  {renderInline(block.text || "")}
                </p>
              );
            })
          ) : (
            <p className="update-notes-empty">
              No detailed release notes were provided for this release.
            </p>
          )}
        </div>

        <div className="modal-actions update-notes-actions">
          <button
            type="button"
            className="button ghost update-notes-changelog-btn"
            onClick={() => {
              void openUrl(CHANGELOG_URL).catch(() => {});
            }}
          >
            <span>Full Change Log</span>
            <ExternalLinkIcon />
          </button>
          <div className="update-notes-primary-actions">
            <button type="button" className="button ghost" onClick={onClose}>
              Close
            </button>
            {onInstallUpdate ? (
              <button
                type="button"
                className="button danger settings-update-action-danger"
                disabled={updateBusy != null}
                onClick={() => {
                  onClose();
                  onInstallUpdate();
                }}
              >
                {updateBusy === "installing" ? "Installing…" : "Update"}
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}
