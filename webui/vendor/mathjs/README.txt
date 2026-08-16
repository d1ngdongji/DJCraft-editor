math.js 15.2.0
================

Upstream: https://mathjs.org/
Browser bundle: https://unpkg.com/mathjs@15.2.0/lib/browser/math.js
License: Apache-2.0 (see math.js.LICENSE.txt)
Vendored SHA-256: 0BB1F6EEE00E00110F493D9BDCC3985BF6C490DA595538EE9A74AC06E40A5029

This is the full browser bundle, vendored locally so Beat Track Studio remains
portable and works without network access. It is used only to evaluate bulk
event-property expressions in the Advanced Editor.

The UMD wrapper's global target is changed from `this` to `window`. The library
body is otherwise identical to the upstream bundle. This makes the global
`math` object explicit in browsers that isolate a classic script's top-level
`this`.
