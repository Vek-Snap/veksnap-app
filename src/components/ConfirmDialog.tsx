"use client";

import { useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void;
  onCancel?: () => void;
  /** Optional third action (e.g. "Don't Save"). When set, a middle button is
   * rendered between Cancel and Confirm. */
  tertiaryLabel?: string;
  onTertiary?: () => void;
}

export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
  onCancel,
  tertiaryLabel,
  onTertiary,
}: ConfirmDialogProps) {
  const handleCancel = useCallback(() => {
    onOpenChange(false);
    onCancel?.();
  }, [onOpenChange, onCancel]);

  const handleConfirm = useCallback(() => {
    onOpenChange(false);
    onConfirm();
  }, [onOpenChange, onConfirm]);

  const handleTertiary = useCallback(() => {
    onOpenChange(false);
    onTertiary?.();
  }, [onOpenChange, onTertiary]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-3 sm:gap-3">
          <Button variant="outline" onClick={handleCancel}>
            {cancelLabel}
          </Button>
          {tertiaryLabel && (
            <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={handleTertiary}>
              {tertiaryLabel}
            </Button>
          )}
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
