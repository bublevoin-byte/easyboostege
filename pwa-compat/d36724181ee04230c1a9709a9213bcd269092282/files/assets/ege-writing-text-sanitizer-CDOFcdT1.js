var e=/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu,t=/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/gu,n=/<\/?[a-zA-Z][^<>]{0,200}>/gu,r=/<!--[\s\S]*?-->/gu;function i(i){return String(i??``).normalize(`NFC`).replace(/\r\n?/gu,`
`).replace(r,` `).replace(n,` `).replace(e,``).replace(t,``).replace(/[^\S\n]+/gu,` `).replace(/ *\n */gu,`
`).replace(/\n{3,}/gu,`

`).trim()}export{i as t};