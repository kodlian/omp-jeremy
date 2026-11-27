import { useRef, useState } from "react";
import { Dialog, FormControl, Select, TextInput, Textarea } from "@primer/react";
import { GitBranchIcon } from "@primer/octicons-react";
import { useBoard } from "./store.jsx";

// Submits on ⌘↩ or Ctrl↩ from anywhere in the form, unless a field already handled the key.
const submitOnCommandEnter = submit => e => {
  if (!e.defaultPrevented && e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
};

export function NewWorktreeDialog({ after, prompt: initial, onClose }) {
  const { view, actions } = useBoard();
  const project = view.project;
  const [prompt, setPrompt] = useState(initial || "");
  const [branch, setBranch] = useState("");
  const [parent, setParent] = useState(after || "");
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  const promptField = useRef(null), branchField = useRef(null);
  const submit = async () => {
    const text = prompt.trim(), name = branch.trim();
    if (busy) return;
    if (!text && !name) { setMissing(true); branchField.current?.focus(); return; }
    setBusy(true);
    try { await actions.createWorktree({ branch: name, prompt: text, after: parent }); onClose(); }
    catch { setBusy(false); }
  };
  return (
    <Dialog title="New worktree" subtitle={project.name} width="large" initialFocusRef={promptField} onClose={onClose}
      footerButtons={[{ content: "Cancel", onClick: onClose }, { content: "Create worktree", buttonType: "primary", loading: busy, onClick: submit }]}>
      <div className="dialog-form" onKeyDown={submitOnCommandEnter(submit)}>
        <FormControl>
          <FormControl.Label>Prompt</FormControl.Label>
          <Textarea ref={promptField} block rows={5} resize="vertical" value={prompt} onChange={e => { setPrompt(e.target.value); setMissing(false); }}
            placeholder="What should change, and why? Its omp plans this first and you review the plan in its terminal." />
          <FormControl.Caption>Optional. With a prompt its omp starts there in plan mode; ⌘↩ creates the worktree</FormControl.Caption>
        </FormControl>
        <div className="dialog-row">
          <FormControl>
            <FormControl.Label>Branch</FormControl.Label>
            <TextInput ref={branchField} block className="mono" leadingVisual={GitBranchIcon} value={branch} autoComplete="off" spellCheck={false}
              placeholder={prompt.trim() ? "feature/… from the prompt" : "feature/my-change"} validationStatus={missing ? "error" : undefined}
              onChange={e => { setBranch(e.target.value); setMissing(false); }}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); submit(); } }} />
            {missing
              ? <FormControl.Validation variant="error">Give it a branch name or a prompt</FormControl.Validation>
              : <FormControl.Caption>Optional with a prompt: named from it</FormControl.Caption>}
          </FormControl>
          <FormControl>
            <FormControl.Label>After</FormControl.Label>
            <Select block value={parent} onChange={e => setParent(e.target.value)}>
              <Select.Option value="">None, from {project.defaultBranch}</Select.Option>
              {view.worktrees.filter(w => w.branch).map(w => <Select.Option key={w.key} value={w.key}>{w.key}</Select.Option>)}
            </Select>
            <FormControl.Caption>Branches from that checkout's branch, nests under it and depends on it</FormControl.Caption>
          </FormControl>
        </div>
      </div>
    </Dialog>
  );
}

export function TagRulesDialog({ onClose }) {
  const { view, actions } = useBoard();
  const project = view.project;
  const [text, setText] = useState(() => project.tagRules.map(r => `${r.pattern} ${r.tags.join(" ")}`).join("\n"));
  const [busy, setBusy] = useState(false);
  const field = useRef(null);
  const submit = async () => {
    const rules = text.split("\n").map(l => l.trim().split(/\s+/)).filter(([pattern]) => pattern).map(([pattern, ...tags]) => ({ pattern, tags }));
    setBusy(true);
    try { await actions.setTagRules(rules); onClose(); }
    catch { setBusy(false); }
  };
  return (
    <Dialog title="Tag rules" subtitle={project.name} initialFocusRef={field} onClose={onClose}
      footerButtons={[{ content: "Cancel", onClick: onClose }, { content: "Save", buttonType: "primary", loading: busy, onClick: submit }]}>
      <div className="dialog-form" onKeyDown={submitOnCommandEnter(submit)}>
        <p className="dialog-text">Worktrees carry the tags of every rule matching their branch name or their folder name.</p>
        <FormControl>
          <FormControl.Label>Rules</FormControl.Label>
          <Textarea ref={field} block rows={6} resize="vertical" className="mono" value={text} spellCheck={false} onChange={e => setText(e.target.value)}
            placeholder={"feature/nutrition-* nutrition\n*onboarding* onboarding ui"} />
          <FormControl.Caption>One per line: a pattern, then its tags. * matches anything, ? one character; case is ignored</FormControl.Caption>
        </FormControl>
      </div>
    </Dialog>
  );
}

export function ScriptsDialog({ onClose }) {
  const { view, actions } = useBoard();
  const project = view.project;
  const [setup, setSetup] = useState(project.setupScript || "");
  const [teardown, setTeardown] = useState(project.teardownScript || "");
  const [busy, setBusy] = useState(false);
  const field = useRef(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try { await actions.setScripts(setup.trim(), teardown.trim()); onClose(); }
    catch { setBusy(false); }
  };
  const onEnter = e => { if (e.key === "Enter") { e.preventDefault(); submit(); } };
  return (
    <Dialog title="Scripts" subtitle={project.name} initialFocusRef={field} onClose={onClose}
      footerButtons={[{ content: "Cancel", onClick: onClose }, { content: "Save", buttonType: "primary", loading: busy, onClick: submit }]}>
      <div className="dialog-form">
        <p className="dialog-text">Run with bash in a worktree: setup after New worktree creates it, teardown before Remove worktree deletes it. Your createWorktree and removeWorktree commands get their paths instead.</p>
        <FormControl>
          <FormControl.Label>Setup script</FormControl.Label>
          <TextInput ref={field} block className="mono" value={setup} placeholder="None" autoComplete="off" spellCheck={false} onChange={e => setSetup(e.target.value)} onKeyDown={onEnter} />
        </FormControl>
        <FormControl>
          <FormControl.Label>Teardown script</FormControl.Label>
          <TextInput block className="mono" value={teardown} placeholder="None" autoComplete="off" spellCheck={false} onChange={e => setTeardown(e.target.value)} onKeyDown={onEnter} />
        </FormControl>
        <p className="dialog-text">Paths may start with ~. Leave a field empty for none; a value equal to the default in config.json keeps following it.</p>
      </div>
    </Dialog>
  );
}
