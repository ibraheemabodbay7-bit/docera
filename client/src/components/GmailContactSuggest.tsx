import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import type { KeyboardEventHandler } from "react";

export interface GmailContact {
  name?: string;
  email: string;
}

interface DropdownPos {
  top: number;
  left: number;
  width: number;
}

interface GmailContactSuggestProps {
  value: string;
  onChange: (value: string) => void;
  contacts: GmailContact[];
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  inputClassName?: string;
  onKeyDown?: KeyboardEventHandler<HTMLInputElement>;
  "data-testid"?: string;
}

export default function GmailContactSuggest({
  value,
  onChange,
  contacts,
  loading = false,
  disabled,
  placeholder = "recipient@example.com",
  inputClassName = "",
  onKeyDown,
  "data-testid": testId,
}: GmailContactSuggestProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<DropdownPos | null>(null);

  const suggestions = useMemo(() => {
    const q = value.toLowerCase().trim();
    if (!q) return [];
    return contacts
      .filter(
        (c) =>
          (c.name ?? "").toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q),
      )
      .slice(0, 5);
  }, [contacts, value]);

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

  const showLoading = open && pos !== null && loading && contacts.length === 0 && value.trim().length > 0;
  const showDropdown = open && pos !== null && suggestions.length > 0;

  const getInitial = (c: GmailContact) =>
    (c.name ?? c.email).charAt(0).toUpperCase();

  const getDisplayName = (c: GmailContact) =>
    c.name && c.name !== c.email ? c.name : c.email.split("@")[0];

  const selectContact = (email: string) => {
    onChange(email);
    setOpen(false);
  };

  const dropdownContent = showLoading ? (
    <div
      data-testid="gmail-suggest-dropdown"
      style={{
        position: "fixed",
        top: pos!.top,
        left: pos!.left,
        width: pos!.width,
        zIndex: 9999,
      }}
      className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
    >
      <p className="px-4 py-3 text-xs text-muted-foreground">Loading contacts…</p>
    </div>
  ) : showDropdown ? (
    <div
      data-testid="gmail-suggest-dropdown"
      style={{
        position: "fixed",
        top: pos!.top,
        left: pos!.left,
        width: pos!.width,
        zIndex: 9999,
      }}
      className="bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
    >
      {/* Inner scroll wrapper so rounded corners are preserved by the outer overflow-hidden */}
      <div style={{ maxHeight: 220, overflowY: "auto", overscrollBehavior: "contain" }}>
        {suggestions.map((contact, i) => (
          <button
            key={contact.email}
            type="button"
            data-testid={`suggest-gmail-${contact.email}`}
            onMouseDown={(e) => {
              e.preventDefault();
              selectContact(contact.email);
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              selectContact(contact.email);
            }}
            className={`w-full flex items-center gap-3 px-4 py-3 text-left active:bg-muted transition-colors ${
              i < suggestions.length - 1 ? "border-b border-border" : ""
            }`}
          >
            <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
              <span className="text-xs font-bold text-primary">
                {getInitial(contact)}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">
                {getDisplayName(contact)}
              </p>
              <p className="text-xs text-muted-foreground truncate">
                {contact.email}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  ) : null;

  const dropdown = dropdownContent ? createPortal(dropdownContent, document.body) : null;

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
