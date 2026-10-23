import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { RunDetail } from "@/api.ts";
import { ApiError, api } from "@/api.ts";
import { Button } from "@/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

export function NotesDialog({
  run,
  open,
  onOpenChange,
  onSaved,
}: {
  run: RunDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(run.notes ?? "");
  const [savedNotes, setSavedNotes] = useState(run.notes ?? "");
  const [busy, setBusy] = useState(false);
  const dirty = draft !== savedNotes;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run.id` resets the draft when navigating between runs.
  useEffect(() => {
    setDraft(run.notes ?? "");
    setSavedNotes(run.notes ?? "");
  }, [run.id, run.notes]);

  const save = async () => {
    setBusy(true);
    try {
      const notes = draft === "" ? null : draft;
      await api.patchRun(run.id, { notes });
      setSavedNotes(draft);
      toast.success("Notes saved.");
      onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "Could not save notes.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Investigation notes</DialogTitle>
          <DialogDescription>
            Notes stay with this investigation and appear in its evidence report.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={draft}
          rows={7}
          mono
          aria-label="Investigation notes"
          onChange={(event) => setDraft(event.target.value)}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!dirty || busy} loading={busy} onClick={() => void save()}>
            Save notes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
