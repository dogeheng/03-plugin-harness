import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { Dialog as D, Switch as S, Tabs as T, Tooltip as Tip } from "radix-ui";
import type * as React from "react";
import { cn, type Tone } from "../lib/utils.ts";

// ---- Button ------------------------------------------------------------------------

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[8px] text-[13px] font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0 cursor-default select-none",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:brightness-110 active:brightness-95 shadow-sm",
        secondary: "bg-card text-fg border border-border-strong hover:bg-bg-subtle active:bg-border/60 shadow-[0_1px_0_rgb(0_0_0/0.03)]",
        ghost: "text-fg hover:bg-bg-subtle active:bg-border/60",
        danger: "bg-danger text-white hover:brightness-110 active:brightness-95 shadow-sm",
        "danger-ghost": "text-danger hover:bg-danger-soft",
        link: "text-accent underline-offset-2 hover:underline px-0 h-auto",
      },
      size: { sm: "h-7 px-2.5 text-[12.5px]", md: "h-8 px-3", lg: "h-9 px-4", icon: "h-8 w-8", "icon-sm": "h-7 w-7" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({ className, variant, size, ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonStyles>) {
  return <button type="button" className={cn(buttonStyles({ variant, size }), className)} {...props} />;
}

// ---- Badge / status dot -----------------------------------------------------------------

const toneStyles: Record<Tone, string> = {
  success: "bg-success-soft text-success",
  muted: "bg-bg-subtle text-muted border border-border",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  accent: "bg-accent-soft text-accent",
};

export function Badge({ tone = "muted", className, ...props }: React.ComponentProps<"span"> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] font-medium leading-4", toneStyles[tone], className)} {...props} />;
}

const dotStyles: Record<Tone, string> = { success: "bg-success", muted: "bg-muted/60", warning: "bg-warning", danger: "bg-danger", accent: "bg-accent" };

export function Dot({ tone, pulse }: { tone: Tone; pulse?: boolean }) {
  return (
    <span className="relative inline-flex size-2 shrink-0">
      {pulse && <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-50", dotStyles[tone])} />}
      <span className={cn("relative inline-flex size-2 rounded-full", dotStyles[tone])} />
    </span>
  );
}

// ---- Card ---------------------------------------------------------------------------

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("rounded-[12px] border border-border bg-card shadow-card", className)} {...props} />;
}

export function SectionTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("text-[12px] font-semibold uppercase tracking-wide text-muted", className)} {...props} />;
}

// ---- Inputs -------------------------------------------------------------------------

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-8 w-full rounded-[8px] border border-border-strong bg-card px-2.5 text-[13px] text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(
        "w-full resize-none rounded-[10px] border border-border-strong bg-card px-3 py-2 text-[13.5px] text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20",
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn("h-8 rounded-[8px] border border-border-strong bg-card px-2 text-[13px] text-fg focus:border-accent focus:outline-none", className)} {...props} />;
}

export function Switch({ className, ...props }: React.ComponentProps<typeof S.Root>) {
  return (
    <S.Root
      className={cn(
        "relative inline-flex h-[20px] w-[34px] shrink-0 items-center rounded-full bg-border-strong transition-colors data-[state=checked]:bg-success disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <S.Thumb className="block size-[16px] translate-x-[2px] rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[16px]" />
    </S.Root>
  );
}

// ---- Tabs ---------------------------------------------------------------------------

export const Tabs = T.Root;
export function TabsList({ className, ...props }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn("inline-flex items-center gap-0.5 rounded-[9px] bg-bg-subtle p-0.5 border border-border", className)} {...props} />;
}
export function TabsTrigger({ className, ...props }: React.ComponentProps<typeof T.Trigger>) {
  return (
    <T.Trigger
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-[7px] px-3 text-[12.5px] font-medium text-muted transition-colors hover:text-fg data-[state=active]:bg-card data-[state=active]:text-fg data-[state=active]:shadow-sm",
        className,
      )}
      {...props}
    />
  );
}
export function TabsContent({ className, ...props }: React.ComponentProps<typeof T.Content>) {
  return <T.Content className={cn("outline-none", className)} {...props} />;
}

// ---- Dialog -------------------------------------------------------------------------

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
  dismissable = true,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
  dismissable?: boolean;
}) {
  return (
    <D.Root open={open} onOpenChange={(o) => (dismissable || o ? onOpenChange(o) : undefined)}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] data-[state=open]:animate-in" />
        <D.Content
          onEscapeKeyDown={(e) => !dismissable && e.preventDefault()}
          onPointerDownOutside={(e) => !dismissable && e.preventDefault()}
          className={cn(
            "fixed left-1/2 top-[12vh] z-50 flex max-h-[76vh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col rounded-[14px] border border-border bg-card shadow-2xl outline-none",
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 pb-3 pt-4">
            <div className="min-w-0">
              <D.Title className="text-[15px] font-semibold leading-6">{title}</D.Title>
              {description ? <D.Description className="mt-0.5 text-[12.5px] text-muted">{description}</D.Description> : <D.Description className="sr-only">{String(title)}</D.Description>}
            </div>
            {dismissable && (
              <D.Close className="rounded-md p-1 text-muted hover:bg-bg-subtle hover:text-fg" aria-label="关闭">
                <X className="size-4" />
              </D.Close>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ---- Tooltip ------------------------------------------------------------------------

export function Tooltip({ content, children, side = "top" }: { content: React.ReactNode; children: React.ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <Tip.Root delayDuration={300}>
      <Tip.Trigger asChild>{children}</Tip.Trigger>
      <Tip.Portal>
        <Tip.Content side={side} sideOffset={6} className="z-[60] max-w-[280px] rounded-[7px] bg-fg px-2 py-1 text-[12px] leading-[1.4] text-bg shadow-lg">
          {content}
        </Tip.Content>
      </Tip.Portal>
    </Tip.Root>
  );
}
export const TooltipProvider = Tip.Provider;

// ---- Misc ---------------------------------------------------------------------------

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-border-strong bg-bg-subtle px-1 font-mono text-[11px] text-muted">{children}</kbd>;
}

export function Empty({ icon, title, children }: { icon?: React.ReactNode; title: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      {icon && <div className="text-muted/70 [&_svg]:size-8">{icon}</div>}
      <div className="text-[14px] font-medium">{title}</div>
      {children && <div className="max-w-[420px] text-[12.5px] text-muted">{children}</div>}
    </div>
  );
}

export function Code({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn("rounded-[5px] border border-border bg-bg-subtle px-1 font-mono text-[12px]", className)}>{children}</code>;
}

export function Json({ value, className }: { value: unknown; className?: string }) {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    text = String(value);
  }
  return <pre className={cn("max-h-72 overflow-auto rounded-[8px] border border-border bg-bg-subtle p-2.5 font-mono text-[11.5px] leading-[1.45] whitespace-pre-wrap break-all", className)}>{text}</pre>;
}
