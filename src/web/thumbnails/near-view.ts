/**
 * Run something once an element comes near the view: a long list of cards (a collection's page)
 * asks for the pictures of the cards that can be seen, and the next ones as the page scrolls,
 * instead of every picture at once. One IntersectionObserver for each scrolling box.
 */

/** How far below and above the view a card already counts as near. */
const MARGIN = '400px 0px';

const waiting = new Map<Element, () => void>();
/** One observer per scrolling box (kept only while the box is), and one for the window. */
const observers = new WeakMap<Element, IntersectionObserver>();
let windowObserver: IntersectionObserver | null = null;

/** The box that scrolls the element (a page with overflow: auto), or null for the window. */
function scroller(element: Element): Element | null {
  for (let box = element.parentElement; box && box !== document.body; box = box.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(box).overflowY)) return box;
  }
  return null;
}

function observerFor(root: Element | null): IntersectionObserver {
  let observer = root ? observers.get(root) : windowObserver;
  if (!observer) {
    const made = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const near = waiting.get(entry.target);
          waiting.delete(entry.target);
          made.unobserve(entry.target);
          near?.();
        }
      },
      // The margin counts only on the root, so the root is the box that scrolls.
      { root, rootMargin: MARGIN }
    );
    if (root) observers.set(root, made);
    else windowObserver = made;
    observer = made;
  }
  return observer;
}

/** Call `near` once, when `element` first comes near the view. Answers a function that stops waiting. */
export function whenNearView(element: Element, near: () => void): () => void {
  // No observer in this browser: at once, as before.
  if (typeof IntersectionObserver === 'undefined') {
    near();
    return () => {};
  }
  const observer = observerFor(scroller(element));
  waiting.set(element, near);
  observer.observe(element);
  return () => {
    if (waiting.delete(element)) observer.unobserve(element);
  };
}
