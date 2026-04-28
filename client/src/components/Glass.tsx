import { useRef } from "react";

export function GlassCard({ children, style, className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={className}
      style={{
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        background: "rgba(28,28,32,0.85)",
        border: "1px solid rgba(255,255,255,0.10)",
        boxShadow: "0 8px 32px rgba(0,0,0,0.28)",
        ...style,
      }}
      {...props}
    >
      {children}
    </div>
  );
}

interface GlassModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function GlassModal({ open, onClose, children, style }: GlassModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0"
      style={{ zIndex: 1000, animation: "glassBackdropIn 0.25s cubic-bezier(0.25,1,0.5,1) both" }}
      onClick={onClose}
    >
      <div style={{
        position: "absolute", inset: 0,
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        background: "rgba(0,0,0,0.45)",
      }} />
      <div
        onClick={e => e.stopPropagation()}
        style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          borderRadius: "20px 20px 0 0",
          backdropFilter: "blur(20px)",
          WebkitBackdropFilter: "blur(20px)",
          background: "rgba(10,10,12,0.92)",
          border: "1px solid rgba(255,255,255,0.10)",
          paddingBottom: "max(24px, env(safe-area-inset-bottom))",
          animation: "sheetSlideUp 0.32s cubic-bezier(0.25,1,0.5,1) both",
          willChange: "transform, opacity",
          ...style,
        }}
      >
        <div style={{ width: 36, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.25)", margin: "10px auto 0" }} />
        {children}
      </div>
    </div>
  );
}

export function AnimatedButton({
  children, onTouchStart, onTouchEnd, onTouchCancel, onTouchMove, style, ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      onTouchStart={e => { if (ref.current) ref.current.style.transform = "scale(0.96)"; onTouchStart?.(e); }}
      onTouchEnd={e => { if (ref.current) ref.current.style.transform = "scale(1)"; onTouchEnd?.(e); }}
      onTouchCancel={e => { if (ref.current) ref.current.style.transform = "scale(1)"; onTouchCancel?.(e); }}
      onTouchMove={e => { if (ref.current) ref.current.style.transform = "scale(1)"; onTouchMove?.(e); }}
      style={{
        transition: "transform 0.10s cubic-bezier(0.25,1,0.5,1)",
        willChange: "transform",
        ...style,
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export function PageTransition({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        animation: "pageScaleIn 0.28s cubic-bezier(0.25,1,0.5,1) both",
        willChange: "transform, opacity",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        ...style,
      }}
    >
      {children}
    </div>
  );
}
