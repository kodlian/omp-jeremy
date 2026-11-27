import { createContext, use, useLayoutEffect, useSyncExternalStore } from "react";
import { useToast } from "omp-web-design-system/toasts";

const ReviewContext = createContext(null);

export function ReviewProvider({ review, children }) {
  const toast = useToast();
  useLayoutEffect(() => {
    review.toast = toast;
  }, [review, toast]);
  return <ReviewContext value={review}>{children}</ReviewContext>;
}

export const useReview = () => use(ReviewContext);

// Select primitives or slices that stay referentially stable until they change.
export function useStore(select) {
  const review = use(ReviewContext);
  return useSyncExternalStore(review.subscribe, () => select(review.state));
}
