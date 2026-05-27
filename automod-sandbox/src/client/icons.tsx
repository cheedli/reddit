import type { ReactNode } from 'react';

type IconProps = {
  className?: string | undefined;
};

function SvgIcon({
  className,
  children,
  viewBox = '0 0 24 24',
}: IconProps & { children: ReactNode; viewBox?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox={viewBox}
    >
      {children}
    </svg>
  );
}

export function BoltIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M13 2 6 13h5l-1 9 8-12h-5l1-8Z" />
    </SvgIcon>
  );
}

export function CheckCircleIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.2 2.2 4.8-5.2" />
    </SvgIcon>
  );
}

export function SparkIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="m12 3 1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
      <path d="m18.5 4 .5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5Z" />
      <path d="m5.5 15 .6 1.9 1.9.6-1.9.6-.6 1.9-.6-1.9-1.9-.6 1.9-.6.6-1.9Z" />
    </SvgIcon>
  );
}

export function KeyIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <circle cx="8.5" cy="15.5" r="3.5" />
      <path d="M11 13h9" />
      <path d="M17 13v3" />
      <path d="M14 13v2" />
    </SvgIcon>
  );
}

export function TrayIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M4 5h16v11H15l-2.2 3h-1.6L9 16H4Z" />
      <path d="M8 9h8" />
    </SvgIcon>
  );
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M14 5h5v5" />
      <path d="m10 14 9-9" />
      <path d="M19 13v4a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4" />
    </SvgIcon>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </SvgIcon>
  );
}

export function SlashCircleIcon({ className }: IconProps) {
  return (
    <SvgIcon className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 15.5 7-7" />
    </SvgIcon>
  );
}
