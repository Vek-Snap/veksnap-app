"use client";

import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { X, CheckCircle2, AlertTriangle, Info, AlertCircle } from "lucide-react";

type ToastVariant = "success" | "error" | "warning" | "info";

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

interface ToastContextType {
  toast: (message: string, variant?: ToastVariant, duration?: number) => void;
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

const VARIANT_STYLES: Record<ToastVariant, { bg: string; border: string; icon: typeof CheckCircle2; iconColor: string }> = {
  success: { bg: "bg-card", border: "border-emerald-500/40", icon: CheckCircle2, iconColor: "text-emerald-400" },
  error: { bg: "bg-card", border: "border-red-500/40", icon: AlertCircle, iconColor: "text-red-400" },
  warning: { bg: "bg-card", border: "border-amber-500/40", icon: AlertTriangle, iconColor: "text-amber-400" },
  info: { bg: "bg-card", border: "border-blue-500/40", icon: Info, iconColor: "text-blue-400" },
};

export default function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const addToast = useCallback((message: string, variant: ToastVariant = "info", duration = 4000) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, message, variant, duration }]);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}
      {/* Toast container: bottom-right */}
      <div className="fixed bottom-4 right-4 z-[200] flex flex-col-reverse gap-2 pointer-events-none max-w-sm w-full">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={removeToast} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [exiting, setExiting] = useState(false);
  const style = VARIANT_STYLES[toast.variant];
  const Icon = style.icon;

  useEffect(() => {
    const timer = setTimeout(() => setExiting(true), toast.duration);
    return () => clearTimeout(timer);
  }, [toast.duration]);

  useEffect(() => {
    if (exiting) {
      const timer = setTimeout(() => onDismiss(toast.id), 300);
      return () => clearTimeout(timer);
    }
  }, [exiting, onDismiss, toast.id]);

  return (
    <div
      className={`pointer-events-auto flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg ${style.bg} ${style.border} transition-all duration-300 ${
        exiting ? "opacity-0 translate-x-4" : "opacity-100 translate-x-0 animate-in slide-in-from-right-5"
      }`}
    >
      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${style.iconColor}`} />
      <p className="text-sm text-foreground flex-1">{toast.message}</p>
      <button
        onClick={() => setExiting(true)}
        className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
