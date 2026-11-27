import { createContext, use, useCallback, useState } from "react";
import { Banner } from "@primer/react";
import "./toasts.css";

const ToastContext = createContext(null);
export const useToast = () => use(ToastContext);
let nextId = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const dismiss = useCallback(id => setToasts(list => list.filter(t => t.id !== id)), []);
  const toast = useCallback((content, error = false) => {
    const id = ++nextId;
    setToasts(list => [...list, { id, content, error }]);
    setTimeout(() => dismiss(id), error ? 8000 : 4000);
  }, [dismiss]);
  return (
    <ToastContext value={toast}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map(t => (
          <Banner key={t.id} layout="compact" variant={t.error ? "critical" : "success"} title={t.error ? "Failed" : "Done"} hideTitle
            description={t.content} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext>
  );
}
