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
export const ChevronIcon = (props: IconProps) => <Base {...props}><path d="m9 18 6-6-6-6"/></Base>;
export const BellIcon = (props: IconProps) => <Base {...props}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></Base>;
export const CloseIcon = (props: IconProps) => <Base {...props}><path d="M6 6l12 12M18 6 6 18"/></Base>;
export const ClockIcon = (props: IconProps) => <Base {...props}><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></Base>;
export const CheckCircleIcon = (props: IconProps) => <Base {...props}><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></Base>;
export const AlertCircleIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="8" x2="12" y2="12" />
    <line x1="12" y1="16" x2="12.01" y2="16" />
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
export const MenuIcon = (props: IconProps) => <Base {...props}><path d="M4 6h16M4 12h16M4 18h16" /></Base>;
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
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </Base>
);
export const UploadIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
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

export const DevicesIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="8" width="10" height="13" rx="2" />
    <rect x="11" y="3" width="10" height="13" rx="2" />
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
