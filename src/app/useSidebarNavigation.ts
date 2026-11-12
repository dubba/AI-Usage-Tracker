import { useCallback, useEffect, useRef, useState } from "react";
import { ALL_ACCOUNTS_GROUP_ID } from "../features/dashboard/sidebar-groups";
import { createPreferenceStore } from "../shared/lib/preference-store";
import { STORAGE_KEYS } from "../shared/lib/storage";
import { rememberVisiblePageScroll } from "./page-scroll";

export type Section = "activity" | "accounts" | "settings";

function isSection(value: unknown): value is Section {
  return value === "activity" || value === "accounts" || value === "settings";
}

const openSection = createPreferenceStore<Section>(STORAGE_KEYS.openSection, "accounts", isSection);

/**
 * Which page is shown (Usage, the accounts of a sidebar group, or Settings) and whether the
 * sidebar is open as an overlay. Choosing a page, a group, a new group after saving it, or Settings
 * are each one call, so the "set the group, show the accounts, close the sidebar" sequence is
 * written once.
 */
export function useSidebarNavigation() {
  const [selectedGroupId, setSelectedGroupId] = useState(ALL_ACCOUNTS_GROUP_ID);
  const [section, setSection] = useState<Section>(() => {
    openSection.refresh();
    return openSection.get();
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The page on screen, kept here (not read from state) so two shortcuts pressed in quick succession
  // each see the page the previous one chose.
  const currentSection = useRef<Section>(section);

  useEffect(() => {
    openSection.set(section);
  }, [section]);

  /** Shows `next`. */
  const navigate = useCallback((next: Section, closeSidebar: boolean) => {
    rememberVisiblePageScroll();
    currentSection.current = next;
    setSection(next);
    if (closeSidebar) setSidebarOpen(false);
  }, []);

  /** Shows `page`. */
  const showPage = useCallback((page: Exclude<Section, "settings">, closeSidebar: boolean) => {
    navigate(page, closeSidebar);
  }, [navigate]);

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

  const showSettings = useCallback(() => navigate("settings", true), [navigate]);

  /** The keyboard shortcut that steps through the pages in the order of the page switch: Dashboard, Usage, Settings, and round again. */
  const cyclePages = useCallback(() => {
    const order: Section[] = ["accounts", "activity", "settings"];
    navigate(order[(order.indexOf(currentSection.current) + 1) % order.length], true);
  }, [navigate]);

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
    cyclePages,
    toggleSidebar,
    closeSidebar,
  };
}
