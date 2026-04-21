import { MessageSquare, UserRound, FolderOpen, Camera } from "lucide-react";
import type { ActiveView } from "@/App";

interface BottomBarProps {
  activeView: ActiveView;
  onChats: () => void;
  onContacts: () => void;
  onFiles: () => void;
  onCamera: () => void;
}

export default function BottomBar({ activeView, onChats, onContacts, onFiles, onCamera }: BottomBarProps) {
  const isChat = activeView === "inbox" || activeView === "chat";

  const NavBtn = ({
    label, icon: Icon, active, onClick, testId,
  }: { label: string; icon: any; active: boolean; onClick: () => void; testId: string }) => (
    <button
      data-testid={testId}
      onClick={onClick}
      className="flex flex-col items-center gap-1 flex-1"
    >
      <div className={`w-10 h-10 rounded-xl flex items-center justify-center transition-colors duration-150 ${
        active ? "bg-primary text-primary-foreground" : "text-muted-foreground"
      }`}>
        <Icon className="w-5 h-5" />
      </div>
      <span className={`text-[10px] font-medium tracking-wide ${active ? "text-primary" : "text-muted-foreground"}`}>
        {label}
      </span>
    </button>
  );

  return (
    <div
      className="flex-shrink-0 bg-background border-t border-border"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="flex items-center justify-around px-4 h-16">
        <NavBtn label="Chats" icon={MessageSquare} active={isChat} onClick={onChats} testId="nav-chats" />
        <NavBtn label="Contacts" icon={UserRound} active={activeView === "contacts"} onClick={onContacts} testId="nav-contacts" />

        <button
          data-testid="nav-camera"
          onClick={onCamera}
          className="flex flex-col items-center gap-1 -mt-5"
        >
          <div className="w-16 h-16 rounded-2xl bg-primary flex items-center justify-center shadow-lg shadow-primary/30 transition-transform duration-150 active:scale-95">
            <Camera className="w-7 h-7 text-primary-foreground" />
          </div>
          <span className="text-[10px] font-medium tracking-wide text-muted-foreground mt-0.5">Scan</span>
        </button>

        <NavBtn label="Files" icon={FolderOpen} active={activeView === "files"} onClick={onFiles} testId="nav-files" />

        <div className="flex-1" />
      </div>
    </div>
  );
}
