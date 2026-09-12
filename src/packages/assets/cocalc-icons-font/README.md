# Legacy icon-font assets

1. generate font at icomoon.io or similar (this was the only one I found that worked well) -- config file is `CoCalc.json`
2. The legacy generated font CSS used this `@font-face` block:

```
       @font-face {
         font-family: 'cocalc-icons';
         src:  url('./cocalc-icons.eot');
         src:  url('./cocalc-icons.eot') format('embedded-opentype'),
           url('./cocalc-icons.ttf') format('truetype'),
           url('./cocalc-icons.woff') format('woff'),
           url('./cocalc-icons.svg') format('svg');
         font-weight: normal;
         font-style: normal;
       }
```

The current frontend loads its generated Iconfont bundle through
`frontend/components/icon.tsx` and `frontend/components/iconfont.cn/`. Changing
these legacy font files does not update that bundle. The external iconfont.cn
collection and its publishing access require separate verification; the steps
above are historical asset-generation notes, not the current release procedure.
