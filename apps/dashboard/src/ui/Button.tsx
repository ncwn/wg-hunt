import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Icon, type IconName } from "./Icon.js";

export type ButtonVariant = "primary" | "secondary" | "soft" | "ghost" | "bright" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md") {
  return `wh-btn wh-btn-${variant} wh-btn-${size}`;
}

type Common = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  children?: ReactNode;
};

function Inside({
  icon,
  iconAfter,
  size,
  children,
}: Common & { iconAfter?: IconName | undefined }) {
  const px = size === "sm" ? 16 : 18;
  return (
    <>
      {icon && <Icon name={icon} size={px} />}
      {children !== undefined && children !== null && <span>{children}</span>}
      {iconAfter && <Icon name={iconAfter} size={px} />}
    </>
  );
}

export function Button({
  variant,
  size = "md",
  icon,
  className,
  children,
  type = "button",
  ...rest
}: Common & ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return (
    <button
      type={type}
      {...rest}
      className={
        className ? `${buttonClass(variant, size)} ${className}` : buttonClass(variant, size)
      }
    >
      <Inside icon={icon} size={size}>
        {children}
      </Inside>
    </button>
  );
}

export function LinkButton({
  variant,
  children,
  external = false,
  ...rest
}: Pick<Common, "variant" | "children"> &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "className"> & {
    href: string;
    external?: boolean;
  }) {
  return (
    <a
      {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      {...rest}
      className={buttonClass(variant)}
    >
      <Inside iconAfter={external ? "external" : undefined} size="md">
        {children}
      </Inside>
    </a>
  );
}

export function IconButton({
  icon,
  label,
  tone = "filled",
  className,
  ...rest
}: {
  icon: IconName;
  label: string;
  tone?: "filled" | "plain";
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children">) {
  const classes = ["wh-iconbtn", tone === "plain" && "wh-iconbtn-plain", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" {...rest} className={classes} aria-label={label} title={label}>
      <Icon name={icon} size={20} />
    </button>
  );
}
