# -*- coding: utf-8 -*-
"""Builds one page per service from a single template, so the seven stay
consistent with each other and with the rest of the site.

    python3 tools/build-service-pages.py

Rewrites services/<slug>/index.html for every entry in service_data.py.
Edit the copy, the header or the layout here rather than in the seven
generated files, or the next run will overwrite it. The header markup
below is duplicated by hand in the five hand-written pages (index, about,
contact, services, work) — keep them in step.

Not uploaded to the web server: the deploy workflow skips tools/."""
import glob, os, sys, json, pathlib
sys.path.insert(0, os.path.dirname(__file__))
from service_data import SERVICES, ALT, SITE

ROOT = pathlib.Path(__file__).resolve().parent.parent
V = "3"

HEADER = '''<header class="site-header">
  <a href="/" class="logo" aria-label="New Image Construction &amp; Remodeling — home">
    <img src="/assets/logo/newimage-logo.webp" alt="New Image Construction &amp; Remodeling" height="46" />
  </a>
  <button class="menu-toggle" aria-label="Toggle menu" aria-expanded="false">
    <span></span><span></span><span></span>
  </button>
  <nav class="main-nav">
    <a href="/">Home</a>
    <div class="nav-item" data-nav-item>
      <a href="/services/">Services</a>
      <button class="nav-sub-toggle" type="button" data-nav-toggle
              aria-expanded="false" aria-controls="nav-services" aria-label="Services submenu">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>
      </button>
      <ul class="nav-sub" id="nav-services">
        <li><a href="/services/kitchen/">Kitchen</a></li>
        <li><a href="/services/bathroom/">Bathroom</a></li>
        <li><a href="/services/closets/">Closets</a></li>
        <li><a href="/services/floor/">Floor</a></li>
        <li><a href="/services/painting/">Painting</a></li>
        <li><a href="/services/exterior-work/">Exterior Work</a></li>
        <li><a href="/services/custom-wall-units/">Custom Wall Units</a></li>
      </ul>
    </div>
    <a href="/work/">Our Work</a>
    <a href="/about/">About</a>
    <a href="/contact/">Contact</a>
    <a href="/contact/" class="btn btn-solid nav-cta">Free Estimate</a>
  </nav>
</header>'''

FOOTER = '''<footer class="site-footer">
  <div class="container footer-grid">
    <div>
      <a href="/" class="logo">
        <img src="/assets/logo/newimage-logo.webp" alt="New Image Construction &amp; Remodeling" height="40" />
      </a>
      <p class="footer-tagline">From Concept to Creation — custom remodeling for South Florida &amp; the Treasure Coast.</p>
    </div>
    <div>
      <h4>Services</h4>
      <div class="footer-links">
__SERVICE_LINKS__
      </div>
    </div>
    <div>
      <h4>Get In Touch</h4>
      <div class="footer-links">
        <a href="tel:+19546874949">(954) 687-4949</a>
        <a href="mailto:info@newimageremodeling.co">info@newimageremodeling.co</a>
        <a href="https://www.instagram.com/newimageconstruction_remodel/" target="_blank" rel="noopener">Instagram</a>
        <a href="https://www.facebook.com/profile.php?id=100067156015493" target="_blank" rel="noopener">Facebook</a>
      </div>
    </div>
  </div>
  <div class="container footer-bottom">
    <span>&copy; <span data-year></span> New Image Construction &amp; Remodeling. All rights reserved.</span>
    <span>South Florida &amp; Treasure Coast</span>
    <span>Website by <a href="https://digicyus.com" target="_blank" rel="noopener">DigiCy</a></span>
  </div>
</footer>'''

SERVICE_LINKS = "\n".join(
    f'        <a href="/services/{s["slug"]}/">{s["title"]}</a>' for s in SERVICES)
FOOTER = FOOTER.replace("__SERVICE_LINKS__", SERVICE_LINKS)


def images(svc):
    if not svc["folder"]:
        return []
    files = sorted(glob.glob(str(ROOT / "assets/images/gallery" / svc["folder"] / "*.webp")))
    alts = ALT[svc["folder"]]
    assert len(files) == len(alts), f'{svc["folder"]}: {len(files)} archivos vs {len(alts)} alts'
    return [("/" + os.path.relpath(f, ROOT), a) for f, a in zip(files, alts)]


def carousel(svc, imgs):
    slides = "\n".join(
        f'''          <li class="carousel-slide">
            <img src="{src}" alt="{alt}." loading="lazy" decoding="async" />
          </li>''' for src, alt in imgs)
    dots = "\n".join(
        f'        <li><button type="button" data-carousel-dot="{i}" aria-label="Go to image {i+1} of {len(imgs)}"></button></li>'
        for i in range(len(imgs)))
    return f'''      <div class="carousel" data-carousel>
        <div class="carousel-viewport" data-carousel-viewport tabindex="0"
             role="group" aria-roledescription="carousel" aria-label="{svc["title"]} projects">
          <ul class="carousel-track">
{slides}
          </ul>
        </div>

        <div class="carousel-ui">
          <button class="carousel-btn" type="button" data-carousel-prev aria-label="Previous image">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M15 4 7 12l8 8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
          </button>
          <p class="carousel-status" aria-live="polite" aria-atomic="true">
            <span data-carousel-index>1</span><span class="carousel-sep">/</span><span>{len(imgs)}</span>
          </p>
          <button class="carousel-btn" type="button" data-carousel-next aria-label="Next image">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 4l8 8-8 8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>
          </button>
        </div>

        <ol class="carousel-dots" data-carousel-dots>
{dots}
        </ol>
      </div>'''


VIDEOS = '''
<section class="section svc-film">
  <div class="container">
    <p class="eyebrow" data-animate>Walk-through</p>
    <h2 class="section-title" data-animate data-animate-delay="1">Step inside a finished closet</h2>
    <p class="section-lede" data-animate data-animate-delay="2">Two short walk-throughs of completed builds — shelving, drawers and integrated LED lighting.</p>
    <div class="svc-film-grid" data-animate data-animate-delay="1">
      <figure>
        <video controls preload="metadata" playsinline
               poster="/assets/video/closet-walkthrough-1-poster.webp"
               src="/assets/video/closet-walkthrough-1.mp4"></video>
        <figcaption>Walk-in closet with LED-lit shelving and a full drawer bank</figcaption>
      </figure>
      <figure>
        <video controls preload="metadata" playsinline
               poster="/assets/video/closet-walkthrough-2-poster.webp"
               src="/assets/video/closet-walkthrough-2.mp4"></video>
        <figcaption>Hanging rails, adjustable shelving and integrated lighting</figcaption>
      </figure>
    </div>
  </div>
</section>'''


def page(svc):
    imgs = images(svc)
    hero_src = imgs[svc["hero"]][0] if imgs else None
    hero_alt = imgs[svc["hero"]][1] if imgs else None
    others = [o for o in SERVICES if o["slug"] != svc["slug"]]

    head_preload = (f'<link rel="preload" as="image" href="{hero_src}" fetchpriority="high" />\n'
                    if hero_src else "")
    og_image = f"{SITE}{hero_src}" if hero_src else f"{SITE}/assets/logo/newimage-logo.png"

    hero_media = (f'''  <div class="svc-hero-media">
    <img src="{hero_src}" alt="{hero_alt}." fetchpriority="high" decoding="async" />
  </div>''' if hero_src else '  <div class="svc-hero-media svc-hero-media--plain"></div>')

    gallery = ""
    if imgs:
        gallery = f'''
<section class="section svc-gallery">
  <div class="container">
    <p class="eyebrow" data-animate>Selected Work</p>
    <h2 class="section-title" data-animate data-animate-delay="1">{svc["title"]} projects</h2>
    <div data-animate data-animate-delay="2" style="margin-top:2.6rem;">
{carousel(svc, imgs)}
    </div>
  </div>
</section>'''

    films = VIDEOS if svc.get("videos") else ""

    body_html = "\n      ".join(f'<p>{p}</p>' for p in svc["body"])

    more = "\n".join(
        f'''      <a class="svc-more-card" href="/services/{o["slug"]}/">
        <span class="num">{o["num"]}</span>
        <h3>{o["title"]}</h3>
      </a>''' for o in others)

    schema = json.dumps({
        "@context": "https://schema.org",
        "@type": "Service",
        "serviceType": svc["title"],
        "name": f'{svc["title"]} Remodeling',
        "areaServed": "South Florida & Treasure Coast",
        "url": f'{SITE}/services/{svc["slug"]}/',
        "provider": {
            "@type": "HomeAndConstructionBusiness",
            "name": "New Image Construction & Remodeling",
            "telephone": "+1-954-687-4949",
            "email": "info@newimageremodeling.co",
            "url": SITE + "/"
        }
    }, indent=2)

    crumbs = json.dumps({
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/"},
            {"@type": "ListItem", "position": 2, "name": "Services", "item": SITE + "/services/"},
            {"@type": "ListItem", "position": 3, "name": svc["title"],
             "item": f'{SITE}/services/{svc["slug"]}/'}
        ]
    }, indent=2)

    return f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{svc["title"]} Remodeling | New Image Construction &amp; Remodeling</title>
<meta name="description" content="{svc["meta"]}" />
<link rel="canonical" href="{SITE}/services/{svc["slug"]}/" />
<meta property="og:type" content="website" />
<meta property="og:title" content="{svc["title"]} Remodeling | New Image Construction &amp; Remodeling" />
<meta property="og:description" content="{svc["meta"]}" />
<meta property="og:image" content="{og_image}" />
<meta property="og:url" content="{SITE}/services/{svc["slug"]}/" />
<meta name="robots" content="index, follow" />
<link rel="icon" type="image/png" sizes="32x32" href="/assets/logo/favicon-32.png" />
<link rel="apple-touch-icon" sizes="180x180" href="/assets/logo/apple-touch-icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
{head_preload}<link rel="stylesheet" href="/css/styles.css?v={V}" />
<script type="application/ld+json">
{schema}
</script>
<script type="application/ld+json">
{crumbs}
</script>
</head>
<body>

{HEADER}

<section class="svc-hero">
{hero_media}
  <div class="container svc-hero-inner">
    <nav class="crumbs" aria-label="Breadcrumb">
      <a href="/">Home</a><span aria-hidden="true">/</span><a href="/services/">Services</a><span aria-hidden="true">/</span><span aria-current="page">{svc["title"]}</span>
    </nav>
    <p class="svc-num">{svc["num"]}</p>
    <h1 class="svc-title">{svc["title"]}</h1>
    <p class="svc-tagline">{svc["tagline"]}</p>
  </div>
</section>

<section class="section svc-intro">
  <div class="container svc-grid">
    <div class="svc-copy" data-animate>
      {body_html}
    </div>
    <aside class="svc-aside" data-animate data-animate-delay="1">
      <div class="svc-card">
        <h2>Start your project</h2>
        <p>Tell us about your space and we&rsquo;ll walk you through what it takes.</p>
        <dl class="svc-facts">
          <dt>Service area</dt><dd>South Florida &amp; Treasure Coast</dd>
          <dt>Phone</dt><dd><a href="tel:+19546874949">(954) 687-4949</a></dd>
          <dt>Email</dt><dd><a href="mailto:info@newimageremodeling.co">info@newimageremodeling.co</a></dd>
        </dl>
        <a href="/contact/" class="btn btn-solid">Schedule a Free Estimate</a>
      </div>
    </aside>
  </div>
</section>
{gallery}{films}
<section class="section svc-more">
  <div class="container">
    <p class="eyebrow" data-animate>More Services</p>
    <h2 class="section-title" data-animate data-animate-delay="1">Explore the rest of what we build</h2>
    <div class="svc-more-grid" data-animate data-animate-delay="2">
{more}
    </div>
  </div>
</section>

<section class="section" style="text-align:center;">
  <div class="container">
    <p class="eyebrow" data-animate style="justify-content:center;">Get In Touch</p>
    <h2 class="section-title" data-animate data-animate-delay="1" style="margin:0 auto; text-align:center;">Ready to start your {svc["title"].lower()} project?</h2>
    <div class="btn-row" style="justify-content:center; margin-top:2rem;" data-animate data-animate-delay="2">
      <a href="/contact/" class="btn btn-solid">Schedule a Free Estimate</a>
      <a href="tel:+19546874949" class="btn">Call (954) 687-4949</a>
    </div>
  </div>
</section>

{FOOTER}

<script src="/js/main.js?v={V}"></script>
</body>
</html>
'''


written = []
for svc in SERVICES:
    d = ROOT / "services" / svc["slug"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "index.html").write_text(page(svc), encoding="utf-8")
    n = len(images(svc))
    written.append(f'  /services/{svc["slug"]}/  {n} imagenes' + ("  + 2 videos" if svc.get("videos") else ""))

print("Paginas generadas:")
print("\n".join(written))
