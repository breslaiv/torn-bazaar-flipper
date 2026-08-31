#!/usr/bin/env python3
"""Stempelt APP_VERSION in jeden relativen Import und jedes Script-Tag.

Warum: GitHub Pages liefert Dateien mit max-age=600 aus, und iOS haelt eine
zum Home-Bildschirm hinzugefuegte Seite noch hartnaeckiger fest. Ein Deploy
kam damit beim Nutzer nicht an - zweimal wurde ein laengst behobener Fehler
erneut gemeldet, weil der Browser den alten Stand ausfuehrte.

Ein Query-Parameter an der URL macht jede Version zu einer eigenen Ressource.
Das Entry-Script allein zu versionieren reicht nicht: seine Importe loesen
relativ zur Modul-URL ohne Query auf und blieben im Cache. Deshalb bekommt
jeder relative Import den Stempel.

Aufruf:  python3 tools/version-assets.py
Danach:  npm test   (tests/version.test.mjs haelt die Konsistenz fest)
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def current_version():
    text = (ROOT / 'js' / 'config.js').read_text(encoding='utf-8')
    match = re.search(r"APP_VERSION\s*=\s*'([^']+)'", text)
    if not match:
        sys.exit("APP_VERSION nicht in js/config.js gefunden")
    return match.group(1)


def stamp_js(version):
    # from './x.js'  oder  from './x.js?v=alt'   ->   from './x.js?v=neu'
    pattern = re.compile(r"""(from\s+['"])(\.{1,2}/[^'"?]+\.js)(\?v=[^'"]*)?(['"])""")
    changed = []
    for path in sorted((ROOT / 'js').glob('*.js')):
        text = path.read_text(encoding='utf-8')
        new = pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(4)}", text)
        if new != text:
            path.write_text(new, encoding='utf-8')
            changed.append(path.name)
    return changed


def stamp_html(version):
    pattern = re.compile(r"""(<script[^>]*\ssrc=")([^"?]+\.js)(\?v=[^"]*)?(")""")
    changed = []
    for path in sorted(ROOT.glob('*.html')):
        text = path.read_text(encoding='utf-8')
        new = pattern.sub(lambda m: f"{m.group(1)}{m.group(2)}?v={version}{m.group(4)}", text)
        if new != text:
            path.write_text(new, encoding='utf-8')
            changed.append(path.name)
    return changed


def main():
    version = current_version()
    js = stamp_js(version)
    html = stamp_html(version)
    print(f"Version {version} gestempelt.")
    print(f"  js:   {', '.join(js) if js else 'nichts zu aendern'}")
    print(f"  html: {', '.join(html) if html else 'nichts zu aendern'}")


if __name__ == '__main__':
    main()
