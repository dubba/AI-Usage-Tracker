import { useCallback, useState } from "react";
import { ALL_ACCOUNTS_GROUP_ID } from "../features/dashboard/sidebar-groups";

export type Section = "accounts" | "settings";

/**
 * Which page is shown (the accounts of a sidebar group, or Settings) and whether the sidebar is
 * open as an overlay. Choosing a group, a new group after saving it, or Settings are each one
 * call, so the "set the group, show the accounts, close the sidebar" sequence is written once.
 */
export function useSidebarNavigation() {
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_ACCOUNTS_GROUP_ID);
  const [section, setSection] = useState<Section>("accounts");
  const [sidebarOpen, setSidebarOpen] = useState(false);

  /** Shows the accounts of `groupId`. Pass `closeSidebar` when the choice was made in the sidebar. */
  const selectGroup = useCallback((groupId: string, options: { closeSidebar?: boolean } = {}) => {
    setSelectedGroupId(groupId);
    setSection("accounts");
    if (options.closeSidebar) setSidebarOpen(false);
  }, []);

  /** Falls back to All accounts, without leaving the page that is open (e.g. the group was deleted). */
  const resetGroup = useCallback(() => setSelectedGroupId(ALL_ACCOUNTS_GROUP_ID), []);

  const showSettings = useCallback(() => {
    setSection("settings");
    setSidebarOpen(false);
  }, []);

  /** The keyboard shortcut: Settings, or back to the accounts when Settings is already open. */
  const toggleSettings = useCallback(() => {
    setSection((current) => (current === "settings" ? "accounts" : "settings"));
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
    showSettings,
    toggleSettings,
    toggleSidebar,
    closeSidebar,
  };
}
