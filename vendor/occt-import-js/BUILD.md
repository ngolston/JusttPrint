# occt-import-js build

The STEP and IGES importer the model parse worker loads ([src/web/parse/worker.ts](../../src/web/parse/worker.ts)).

- **Source:** [occt-import-js](https://github.com/kovacsv/occt-import-js) 0.0.23 (MIT, see `license.occt-import-js.txt`), with [OpenCascade](https://github.com/Open-Cascade-SAS/OCCT) at commit `d2abb6d8`, the submodule commit of that tag (LGPL 2.1 with exception, see `license.occt.txt`).
- **Compiler:** Emscripten 3.1.69, the version upstream builds with.
- **Change from the npm package:** linked with `-sDYNAMIC_EXECUTION=0`. Nothing else differs. The npm build's JavaScript builds functions from strings (`new Function`) to call into WebAssembly, which needs `'unsafe-eval'` in the Content Security Policy. This build uses plain closures instead, so the parse worker runs under the same policy as the page: `script-src 'self' 'wasm-unsafe-eval'`.

To rebuild (30 to 60 minutes, about 4 GB of disk):

```bash
scripts/build-occt-import-js.sh
```

`tests/step-occt.test.js` checks the result: it parses STEP and IGES with Node's `--disallow-code-generation-from-strings`, which blocks the same things as the policy.
