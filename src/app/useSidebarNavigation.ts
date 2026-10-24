import { useCallback, useRef, useState } from "react";
import { ALL_ACCOUNTS_GROUP_ID } from "../features/dashboard/sidebar-groups";

export type Section = "activity" | "accounts" | "settings";

/**
 * Which page is shown (Usage, the accounts of a sidebar group, or Settings) and whether the
 * sidebar is open as an overlay. Choosing a page, a group, a new group after saving it, or Settings
 * are each one call, so the "set the group, show the accounts, close the sidebar" sequence is
 * written once.
 */
export function useSidebarNavigation() {
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_ACCOUNTS_GROUP_ID);
  const [section, setSection] = useState<Section>("accounts");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The page Settings was opened from, which the Settings shortcut goes back to.
  const pageBeforeSettings = useRef<Exclude<Section, "settings">>("accounts");

  /** Shows `page`, remembering it as the page Settings returns to. */
  const showPage = useCallback((page: Exclude<Section, "settings">, closeSidebar: boolean) => {
    pageBeforeSettings.current = page;
    setSection(page);
    if (closeSidebar) setSidebarOpen(false);
  }, []);

  /** Shows the accounts of `groupId`. Pass `closeSidebar` when the choice was made in the sidebar. */
  const selectGroup = useCallback(
    (groupId: string, options: { closeSidebar?: boolean } = {}) => {
      setSelectedGroupId(groupId);
      showPage("accounts", Boolean(options.closeSidebar));
    },
    [showPage],
  );

  /** Falls back to All accounts, without leaving the page that is open (e.g. the group was deleted). */
  const resetGroup = useCallback(() => setSelectedGroupId(ALL_ACCOUNTS_GROUP_ID), []);

  const showActivity = useCallback(() => showPage("activity", true), [showPage]);

  /** The accounts page, on whichever group was last chosen. */
  const showAccounts = useCallback(() => showPage("accounts", true), [showPage]);

  const showSettings = useCallback(() => {
    setSection("settings");
    setSidebarOpen(false);
  }, []);

  /** The keyboard shortcut: Settings, or back to the page it was opened from when it is already open. */
  const toggleSettings = useCallback(() => {
    setSection((current) => (current === "settings" ? pageBeforeSettings.current : "settings"));
    setSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => setSidebarOpen((open) => !open), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  return {
    selectedGroupId,
    section,
    sidebarOpen,
    selectGroup,
    resetGroup,
    showActivity,
    showAccounts,
    showSettings,
    toggleSettings,
    toggleSidebar,
    closeSidebar,
  };
}
