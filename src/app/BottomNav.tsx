import { ActivityChartIcon, GridIcon, SettingsIcon } from "../shared/ui/icons";
import type { Section } from "./useSidebarNavigation";
import "./bottom-nav.css";

const ITEMS = [
  { section: "activity", label: "Activity", Icon: ActivityChartIcon },
  { section: "accounts", label: "Accounts", Icon: GridIcon },
  { section: "settings", label: "Settings", Icon: SettingsIcon },
] as const satisfies ReadonlyArray<{ section: Section; label: string; Icon: typeof GridIcon }>;

/**
 * The main navigation on a phone or a narrow window, where the sidebar is an off-canvas overlay:
 * Activity, Accounts and Settings, one tap away. On wider windows the sidebar has the same entries
 * and this bar is not rendered.
 */
export function BottomNav({
  section,
  onSelect,
  inert,
}: {
  section: Section;
  onSelect: (section: Section) => void;
  /** The sidebar overlay is open over the page: nothing behind it takes focus. */
  inert?: boolean;
}) {
  return (
    <nav className="bottom-nav" aria-label="Main" inert={inert}>
      {ITEMS.map(({ section: target, label, Icon }) => {
        const active = section === target;
        return (
          <button
            key={target}
            type="button"
            className={`bottom-nav-item${active ? " is-active" : ""}`}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelect(target)}
          >
            <Icon />
            <span>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
