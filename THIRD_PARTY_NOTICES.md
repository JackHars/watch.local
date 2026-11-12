# Liquid Glass navigation

The backdrop/content separation and masked highlight-rim styling in
`public/app.css` and `public/navigation.mjs` are adapted from
[rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react).
The capsule displacement map, scroll behavior and vanilla DOM integration are
implemented locally; the React package is not bundled.

Copyright 2025 MAX ROVENSKY

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

# ZLive player interoperability

`api/vendor/zlive-resolver.cjs` contains the request signer extracted by the local
Hermes ZLive API project from the public player at [zlive.st](https://zlive.st/).
It is kept separate from the application and executed with an isolated set of
globals. It implements the site's public ticket/resolution protocol, not a
personal account or TMDB credential. Upstream player code remains attributed to
its original authors; this notice does not assign it the application's license.

`api/zlive-media.mjs` is a local implementation of the public player's video
container formats, allowing native HLS clients to consume the resulting video.
Channel metadata and programme information come from ZLive at runtime; no
channel recordings, private session tickets or resolved stream URLs are bundled.
