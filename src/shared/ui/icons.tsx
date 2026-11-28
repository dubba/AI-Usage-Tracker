import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const Base = ({ children, ...props }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
    {children}
  </svg>
);

export const PlusIcon = (props: IconProps) => <Base {...props}><path d="M12 5v14M5 12h14" /></Base>;
export const RefreshIcon = (props: IconProps) => <Base {...props}><path d="M20 11a8.1 8.1 0 0 0-15.5-2M4 5v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2M20 19v-4h-4"/></Base>;
export const UsersIcon = (props: IconProps) => <Base {...props}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></Base>;
export const GaugeIcon = (props: IconProps) => <Base {...props}><path d="M3 12a9 9 0 1 1 18 0"/><path d="m12 12 4-4"/><path d="M5.6 19h12.8"/></Base>;
export const SettingsIcon = (props: IconProps) => <Base {...props}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06-2.83 2.83-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21h-4v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06-2.83-2.83.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3v-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06 2.83-2.83.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3h4v.09A1.65 1.65 0 0 0 15 4.6a1.65 1.65 0 0 0 1.82-.33l.06-.06 2.83 2.83-.06.06A1.65 1.65 0 0 0 19.4 9c.12.37.19.76.2 1.15H21v4h-1.4c-.01.3-.08.59-.2.85Z"/></Base>;
export const CopyIcon = (props: IconProps) => <Base {...props}><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></Base>;
export const TrashIcon = (props: IconProps) => <Base {...props}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></Base>;
export const EditIcon = (props: IconProps) => <Base {...props}><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></Base>;
export const ShieldIcon = (props: IconProps) => <Base {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/></Base>;
export const FolderIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 18V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v3" />
    <path d="M4.2 19.5a1.5 1.5 0 0 1-1.38-2.08l2.12-5.1A2 2 0 0 1 6.78 11.1H20.3a1.5 1.5 0 0 1 1.38 2.08l-2.12 5.1a2 2 0 0 1-1.84 1.22Z" />
  </Base>
);
export const ChevronIcon = (props: IconProps) => <Base {...props}><path d="m9 18 6-6-6-6"/></Base>;
export const ChevronDownIcon = (props: IconProps) => <Base {...props}><path d="m6 9 6 6 6-6"/></Base>;
export const BellIcon = (props: IconProps) => <Base {...props}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></Base>;
export const CloseIcon = (props: IconProps) => <Base {...props}><path d="M6 6l12 12M18 6 6 18"/></Base>;
export const CheckCircleIcon = (props: IconProps) => <Base {...props}><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></Base>;
export const AlertTriangleIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <line x1="12" y1="9" x2="12" y2="13" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </Base>
);
export const BarChartIcon = (props: IconProps) => <Base {...props}><path d="M4 20V4"/><path d="M4 20h16"/><path d="M8.5 20v-6M13 20V8M17.5 20v-9"/></Base>;
export const GridIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
  </Base>
);
export const CalendarOffIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M16 3v3M8 3v3M3 10h5M13 10h8" />
    <path d="M3 8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    <path d="m3 3 18 18" />
  </Base>
);
export const CheckIcon = (props: IconProps) => <Base {...props}><path d="m5 12 5 5L20 7"/></Base>;
/** A funnel: opens the list of accounts and groups, which filters the Dashboard and Usage pages. */
export const FilterIcon = (props: IconProps) => <Base {...props}><path d="M3 4h18l-7 8.5V19l-4 2v-8.5Z" /></Base>;
export const ExternalLinkIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
  </Base>
);
export const CameraIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
    <circle cx="12" cy="13" r="3" />
  </Base>
);
export const DownloadIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 3.8v9" />
    <path d="m8.2 9 3.8 3.8L15.8 9" />
    <path d="M7.2 14.8 4.4 16.3 12 20.4l7.6-4.1-2.8-1.5" />
  </Base>
);
export const UploadIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 12.8V3.8" />
    <path d="m8.2 7.6 3.8-3.8 3.8 3.8" />
    <path d="M7.2 14.8 4.4 16.3 12 20.4l7.6-4.1-2.8-1.5" />
  </Base>
);

export const KeypadIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="4" y="4" width="4" height="4" rx="1" />
    <rect x="10" y="4" width="4" height="4" rx="1" />
    <rect x="16" y="4" width="4" height="4" rx="1" />
    <rect x="4" y="10" width="4" height="4" rx="1" />
    <rect x="10" y="10" width="4" height="4" rx="1" />
    <rect x="16" y="10" width="4" height="4" rx="1" />
    <rect x="10" y="16" width="4" height="4" rx="1" />
  </Base>
);

export const QrIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="5.5" y="5.5" width="2" height="2" />
    <rect x="16.5" y="5.5" width="2" height="2" />
    <rect x="5.5" y="16.5" width="2" height="2" />
    <path d="M14 14h3v3h-3zM18 14h3v2M14 18h2v3M19 19h2v2" />
  </Base>
);

/** Monitor paired with a smartphone: cross-device sync and transfer. */
export const DevicesIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M18 8V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h8" />
    <path d="M10 15v4" />
    <path d="M7 19h5" />
    <rect x="16" y="12" width="6" height="10" rx="1.5" />
  </Base>
);

/** A cloud with a downward arrow: "download an available update". */
export const DownloadCloudIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M4.4 15.3A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.4 8.3" />
    <path d="M12 13v8l-4-4" />
    <path d="m12 21 4-4" />
  </Base>
);

/** A circle with an upward arrow: "upgrade to a newer version". */
export const ArrowUpCircleIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="10" />
    <path d="m16 12-4-4-4 4" />
    <path d="M12 16V8" />
  </Base>
);

export const FlipCameraIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
    <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
    <circle cx="12" cy="12" r="3" />
    <path d="m18 22-3-3 3-3" />
    <path d="m6 2 3 3-3 3" />
  </Base>
);


export const PlayIcon = (props: IconProps) => (
  <Base {...props}>
    <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" />
  </Base>
);

export const PauseIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="5" y="4" width="4" height="16" rx="1" fill="currentColor" />
    <rect x="15" y="4" width="4" height="16" rx="1" fill="currentColor" />
  </Base>
);


export const EyeIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Base>
);
export const EyeOffIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A16.8 16.8 0 0 0 2 12s3.5 7 10 7a10 10 0 0 0 5.4-1.6" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    <path d="m3 3 18 18" />
  </Base>
);
export const ArrowUpIcon = (props: IconProps) => <Base {...props}><path d="M12 19V5M5 12l7-7 7 7"/></Base>;
export const ArrowDownIcon = (props: IconProps) => <Base {...props}><path d="M12 5v14M19 12l-7 7-7-7"/></Base>;
export const ArrowLeftIcon = (props: IconProps) => <Base {...props}><path d="M19 12H5m7 7-7-7 7-7"/></Base>;
/**
 * New group: stacked layers, the top one filled, with a plus at the lower right. (A person with a
 * plus read as "invite someone".) The lower layers stop short of the plus so it stands clear.
 */
export const StackPlusIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M10 2 18 6 10 10 2 6Z" fill="currentColor" />
    <path d="m2 10.5 8 4 8-4" />
    <path d="m2 15 8 4 3-1.5" />
    {/* The small plus reaches y 22 so the mark is as tall as it is wide (20 units plus the stroke),
        and so the same size as PlusIcon beside it where the two are paired. */}
    <path d="M19 16v6M16 19h6" />
  </Base>
);

/** Three slim horizontal bars: toggle compact single-row account cards. */
export const CompactRowsIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="5" width="18" height="3" rx="1" />
    <rect x="3" y="10.5" width="18" height="3" rx="1" />
    <rect x="3" y="16" width="18" height="3" rx="1" />
  </Base>
);

/** Counter-clockwise clock rewind: resetting or clearing recorded history. */
export const HistoryResetIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 2" />
  </Base>
);

/** Stacked database cylinder: data & diagnostics settings. */
export const DatabaseIcon = (props: IconProps) => (
  <Base {...props}>
    <ellipse cx="12" cy="5" rx="9" ry="3" />
    <path d="M3 5v14a9 3 0 0 0 18 0V5" />
    <path d="M3 12a9 3 0 0 0 18 0" />
  </Base>
);

/** Power plug: local API & integrations settings. */
export const PlugIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M12 22v-5" />
    <path d="M9 8V2" />
    <path d="M15 8V2" />
    <path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
  </Base>
);

/** Keyboard outline: keyboard shortcuts settings. */
export const KeyboardIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M8 13h.01M12 13h.01M16 13h.01M7 16h10" />
  </Base>
);

/** Concentric waves from a point: sending to a nearby device (AirDrop, Quick Share). */
export const NearbyShareIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="1.8" />
    <path d="M8.2 8.2a5.4 5.4 0 0 0 0 7.6M15.8 8.2a5.4 5.4 0 0 1 0 7.6" />
    <path d="M5.1 5.1a9.8 9.8 0 0 0 0 13.8M18.9 5.1a9.8 9.8 0 0 1 0 13.8" />
  </Base>
);

/** A Wi-Fi fan: looking on the local network. */
export const WifiIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M5 12.6a10 10 0 0 1 14 0" />
    <path d="M8.5 16a5 5 0 0 1 7 0" />
    <path d="M1.5 9a15 15 0 0 1 21 0" />
    <path d="M12 19.5h.01" />
  </Base>
);

/** A paper plane: something being sent (the Sending screen's current step). */
export const SendIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="m21.5 2.5-7 19-4-8.5-8.5-4z" />
    <path d="M21.5 2.5 10.5 13" />
  </Base>
);

/** A circled "i": a note that explains, not an action. */
export const InfoIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 7.6h.01" />
  </Base>
);

/** A page with a folded corner: a file. */
export const FileIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
  </Base>
);
