import { Button, SelectPanel } from "@primer/react";
import { GitCommitIcon, TriangleDownIcon } from "@primer/octicons-react";
import { useState } from "react";
import { useReview, useStore } from "./context.jsx";
import { compareKey, relative } from "./model.js";
import { api } from "./review.js";

const AUTO = "__auto__";

const matches = (item, q) => `${item.text} ${item.description ?? ""}`.toLowerCase().includes(q.toLowerCase());

// Loads its items when opened, filters them as you type, and picks a typed ref when nothing matches.
function Picker({ title, placeholder, label, anchorTitle, leadingVisual, width, load, failure, onPick }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [filter, setFilter] = useState("");
  const review = useReview();
  const shown = items?.filter((item) => !filter.trim() || matches(item, filter.trim())) ?? [];

  async function onOpenChange(next) {
    setOpen(next);
    if (!next) return;
    setFilter("");
    setItems(null);
    try {
      setItems(await load());
    } catch (error) {
      setOpen(false);
      review.toast(`${failure}: ${error.message}`, true);
    }
  }

  return (
    <SelectPanel
      title={title}
      placeholderText={placeholder}
      width={width}
      open={open}
      onOpenChange={onOpenChange}
      loading={items == null}
      items={shown}
      selected={undefined}
      onSelectedChange={(item) => {
        setOpen(false);
        if (item) onPick(item.id);
      }}
      filterValue={filter}
      onFilterChange={setFilter}
      message={items && !shown.length ? { variant: "empty", title: "No matches", body: filter.trim() ? "Press Enter to use it as typed." : "Nothing to choose from." } : undefined}
      textInputProps={{
        onKeyDown(e) {
          if (e.key === "Enter" && !shown.length && filter.trim()) {
            e.preventDefault();
            setOpen(false);
            onPick(filter.trim());
          }
        },
      }}
      renderAnchor={(props) => (
        <Button {...props} size="small" className="picker" trailingAction={TriangleDownIcon} leadingVisual={leadingVisual} title={anchorTitle}>
          <span className="chip-label">{label}</span>
        </Button>
      )}
    />
  );
}

export function BasePicker() {
  const review = useReview();
  const base = useStore((s) => s.compare.base ?? s.base?.ref ?? (s.loadedKey === compareKey(s.compare) ? "choose a base" : "…"));
  const branch = useStore((s) => s.branch);
  return (
    <Picker
      title="Compare against"
      placeholder="Compare against… (any ref)"
      label={base}
      anchorTitle={`Change the comparison base: ${base}`}
      width="large"
      failure="Couldn't list branches"
      load={async () => [{ id: AUTO, text: "Automatic", description: "where this branch forked", descriptionVariant: "inline" }, ...(await api("/api/branches")).filter((n) => n !== branch).map((n) => ({ id: n, text: n }))]}
      onPick={(id) => review.setCompare({ kind: "branch", base: id === AUTO ? null : id })}
    />
  );
}

export function CommitPicker() {
  const review = useReview();
  const commit = useStore((s) => s.commit);
  const fresh = useStore((s) => s.loadedKey === compareKey(s.compare));
  return (
    <Picker
      title="Choose a commit"
      placeholder="Find a commit…"
      label={commit ? <><span className="mono">{commit.short}</span> {commit.subject}</> : fresh ? "No commits" : "…"}
      anchorTitle="Choose another commit"
      leadingVisual={GitCommitIcon}
      width="large"
      failure="Couldn't list commits"
      load={async () => (await api("/api/commits")).map((c) => ({ id: c.sha, text: `${c.short}  ${c.subject}`, trailingVisual: relative(c.date) }))}
      onPick={(sha) => review.setCompare({ kind: "commit", sha })}
    />
  );
}
