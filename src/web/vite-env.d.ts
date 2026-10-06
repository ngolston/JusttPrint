/** Vite import suffixes used in src/web. */
declare module '*?worker&url' {
  const url: string;
  export default url;
}

/** Stylesheets imported for their side effect (bundled into web-build/app.css). */
declare module '*.css';

/** A file's text (tests read the design tokens this way). */
declare module '*?raw' {
  const text: string;
  export default text;
}
