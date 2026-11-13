import { Check, ChevronDown, ChevronUp, History, LoaderCircle, MessageSquare, MessageSquarePlus, Pencil, Send, Trash2 } from "lucide";

const ICONS = {
  check: Check,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  history: History,
  loader: LoaderCircle,
  comment: MessageSquare,
  commentAdd: MessageSquarePlus,
  edit: Pencil,
  send: Send,
  trash: Trash2,
};

const attrs = (o) => Object.entries(o).map(([k, v]) => `${k}="${v}"`).join(" ");

export function icon(name, size = 14, className = "") {
  const body = ICONS[name].map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join("");
  return `<svg class="icon${className ? ` ${className}` : ""}" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
