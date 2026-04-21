import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEventHandler } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Client } from "@shared/schema";

interface DropdownPos {
  top: number;
  left: number;
  width: number;
}

interface ClientEmailSuggestProps {
  value: string;
  onChange: (value: string) => void;
  linkedClientId?: string | null;
  disabled?: boolean;
  placeholder?: string;
  inputClassName?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  "data-testid"?: string;
}

export default function ClientEmailSuggest({
  value,
  onChange,
  linkedClientId,
  disabled,
  placeholder = "recipient@example.com",
  inputClassName = "",
  onKeyDown,
  "data-testid": testId,
}: ClientEmailSuggestProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<DropdownPos | null>(null);

  const { data: clients = [] } = useQuery<Client[]>({
    queryKey: ["/api/clients"],
  });

  const suggestions = useMemo(() => {
    const withEmail = clients.filter((c) => c.email);
    const q = value.toLowerCase().trim();

    let list: Client[];
    if (!q) {
      if (linkedClientId) {
        const linked = withEmail.find((c) => c.id === linkedClientId);
        const rest = withEmail.filter((c) => c.id !== linkedClientId);
        list = linked ? [linked, ...rest] : rest;
      } else {
        list = withEmail;
      }
    } else {
      list = withEmail.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.email ?? "").toLowerCase().includes(q)
      );
    }
    return list.slice(0, 6);
  }, [clients, value, linkedClientId]);

  const calcPos = useCallback(() => {
    if (!inputRef.current) return;
    const rect = inputRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  const handleFocus = useCallback(() => {
    calcPos();
    setOpen(true);
  }, [calcPos]);

  const handleBlur = useCallback(() => {
    setTimeout(() => setOpen(false), 180);
  }, []);

  useEffect(() => {
    if (!open) return;
    const update = () => calcPos();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, calcPos]);

  const showDropdown = open && suggestions.length > 0 && pos !== null;

  const dropdown = showDropdown
    ? createPortal(
        <div
          data-testid="client-suggest-dropdown"
          style={{
            position: "fixed",
            top: pos!.top,
            left: pos!.left,
            width: pos!.width,
            zIndex: 9999,
          }}
          className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
        >
          {suggestions.map((client, i) => (
            <button
              key={client.id}
              type="button"
              data-testid={`suggest-client-${client.id}`}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(client.email!);
                setOpen(false);
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                onChange(client.email!);
                setOpen(false);
              }}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left active:bg-muted transition-colors ${
                i < suggestions.length - 1 ? "border-b border-border" : ""
              }`}
            >
              <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <span className="text-xs font-bold text-primary">
                  {client.name.charAt(0).toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="text-sm font-semibold text-foreground truncate">
                    {client.name}
                  </p>
                  {linkedClientId === client.id && (
                    <span className="text-[10px] font-semibold text-primary bg-primary/10 px-1.5 py-0.5 rounded-full flex-shrink-0 leading-none">
                      linked
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground truncate">
                  {client.email}
                </p>
              </div>
            </button>
          ))}
        </div>,
        document.body
      )
    : null;

  return (
    <div className="flex-1 min-w-0">
      <input
        ref={inputRef}
        data-testid={testId}
        type="text"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={handleFocus}
        onBlur={handleBlur}
        disabled={disabled}
        className={inputClassName}
      />
      {dropdown}
    </div>
  );
}
