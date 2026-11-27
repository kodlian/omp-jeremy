import { BaseStyles, ThemeProvider } from "@primer/react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "omp-web-design-system/toasts";
import "omp-web-design-system/primer-theme.css";
import "omp-web-design-system/omp-colors.css";
import { App } from "./App.jsx";
import { ReviewProvider } from "./context.jsx";
import { createReview } from "./review.js";
import { syncScheme, useScheme } from "./scheme.js";

const review = createReview();

syncScheme();
document.getElementById("appearance").addEventListener("load", () => {
  syncScheme();
  review.diff?.syncFontSize();
});

function Root() {
  return (
    <ThemeProvider colorMode={useScheme()}>
      <BaseStyles className="app">
        <ToastProvider>
          <ReviewProvider review={review}>
            <App />
          </ReviewProvider>
        </ToastProvider>
      </BaseStyles>
    </ThemeProvider>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
review.start();
