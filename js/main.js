(() => {
  "use strict";

  const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  const reduceMotion = motionQuery.matches;
  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

  /* ============================================================
     Scroll manager — one listener, one rAF loop for the whole page.
     ============================================================ */
  const scrollTasks = [];
  let frameQueued = false;

  const runTasks = () => {
    frameQueued = false;
    let again = false;
    for (let i = 0; i < scrollTasks.length; i++) {
      if (scrollTasks[i]() === true) again = true;
    }
    if (again) requestFrame();
  };
  const requestFrame = () => {
    if (frameQueued) return;
    frameQueued = true;
    requestAnimationFrame(runTasks);
  };
  const onScrollTask = (fn) => {
    scrollTasks.push(fn);
    requestFrame();
  };

  window.addEventListener("scroll", requestFrame, { passive: true });
  window.addEventListener("resize", requestFrame, { passive: true });

  /* ---------- Header scroll state ---------- */
  const header = document.querySelector(".site-header");
  const heroEl = document.querySelector("[data-hero]");
  const cinemaEl = document.querySelector("[data-cinema]");
  if (header) {
    let lastScrolled = null;
    let lastOverHero = null;
    onScrollTask(() => {
      // Over a cinematic hero the header stays weightless until the film
      // is nearly done; elsewhere it solidifies as soon as you move.
      const act = cinemaEl || heroEl;
      const actEnd = act ? act.offsetTop + act.offsetHeight : 0;
      const y = window.scrollY;
      const overHero = act ? y < actEnd - window.innerHeight * 0.75 : false;
      const scrolled = overHero ? false : y > (act ? actEnd - window.innerHeight : 40);
      if (scrolled !== lastScrolled) {
        lastScrolled = scrolled;
        header.classList.toggle("is-scrolled", scrolled);
      }
      if (overHero !== lastOverHero) {
        lastOverHero = overHero;
        header.classList.toggle("is-over-hero", overHero);
      }
      return false;
    });
  }

  /* ============================================================
     Cinematic hero — the scroll position *is* the video timeline.
     ============================================================ */
  const initCinematicHero = (hero, cinema) => {
    const canvas = cinema.querySelector("[data-hero-canvas]");
    const stage = hero.querySelector(".hero-stage");
    const railItems = Array.from(hero.querySelectorAll(".hero-rail li"));
    const chapters = Array.from(hero.querySelectorAll("[data-chapter]")).map((el) => ({
      el,
      from: parseFloat(el.dataset.from),
      to: parseFloat(el.dataset.to),
      alpha: -1,
      off: null,
      live: null,
      filter: ""
    }));

    // Anything that makes the cinematic version a bad idea falls back to
    // the static hero the base CSS already renders.
    const saveData = (navigator.connection && navigator.connection.saveData) === true;
    if (!canvas || !stage || !chapters.length || reduceMotion || saveData || !canvas.getContext) {
      return;
    }
    chapters[0].isFirst = true;
    chapters[chapters.length - 1].isLast = true;
    cinema.classList.add("is-cinema");

    /* ---- frame sequence ------------------------------------------------
       A scroll-scrubbed <video> asks the browser to seek dozens of times
       a second. On Safari that seek has real, documented latency that
       has nothing to do with network — a screen recording taken on WiFi
       with the file fully buffered still showed the frame frozen for
       over a second at a stretch while scrolling. Plain images sidestep
       the seek pipeline entirely: once one is loaded, drawing it to a
       canvas is synchronous, which is the same reason large scroll-driven
       product pages use image sequences rather than video for this
       exact effect.
       One frame set covers both breakpoints — the source has no crop to
       differ by orientation, so panPercent() just recomputes the cover
       math against whatever box it is drawn into.
    -------------------------------------------------------------------- */
    const FRAME_COUNT = 120;
    const FPS = 15;
    const FRAME_W = 720;
    const FRAME_H = 1280;
    // Maps scroll progress to a fraction of the sequence, built from the
    // clip's own measured frame-to-frame movement (65% motion-equalised,
    // 35% linear) so equal scroll covers roughly equal motion.
    const CURVE = [0, 0.1123, 0.1636, 0.2048, 0.2494, 0.3008, 0.3521, 0.3967, 0.4413, 0.4859,
                   0.5305, 0.5751, 0.6196, 0.6642, 0.7156, 0.7737, 0.8284, 0.8798, 0.921, 0.9588, 1];

    const timeFraction = (p) => {
      const x = clamp(p, 0, 1) * (CURVE.length - 1);
      const i = Math.min(Math.floor(x), CURVE.length - 2);
      return CURVE[i] + (CURVE[i + 1] - CURVE[i]) * (x - i);
    };

    const framePath = (i) => "/assets/hero-frames/f" + String(i + 1).padStart(3, "0") + ".webp";
    const frames = Array.from({ length: FRAME_COUNT }, () => ({ img: new Image(), loaded: false }));

    /* ---- the camera -------------------------------------------------
       Where the visible band should sit inside the frame, as a fraction
       of its height (0 = top, 1 = bottom). Holds low on the blueprints
       and tape measure, rises to centre as the camera pushes through the
       framed structure, then settles slightly low again on the final
       reveal so the pool stays in frame rather than the roofline eating
       the shot. Measured against real rendered crops, not guessed.
    -------------------------------------------------------------------- */
    const bandCenter = (tf) => {
      if (tf <= 0.2) return 0.68;
      if (tf <= 0.45) return 0.68 + ((tf - 0.2) / 0.25) * (0.47 - 0.68);
      if (tf <= 0.85) return 0.47;
      return 0.47 + ((tf - 0.85) / 0.15) * (0.58 - 0.47);
    };

    // `tf` is a fraction of the sequence, not of the scroll.
    const panPercent = (tf) => {
      const boxW = stage.clientWidth;
      const boxH = stage.clientHeight;
      if (!boxW || !boxH) return 50;
      // object-fit: cover, width-constrained is the only case with slack.
      const renderedH = FRAME_H * (boxW / FRAME_W);
      if (renderedH <= boxH + 1) return 50;
      const visible = boxH / renderedH; // fraction of the frame that fits
      const centerInFile = bandCenter(tf);
      return clamp((centerInFile - visible / 2) / (1 - visible), 0, 1) * 100;
    };

    /* ---- frame rendering ------------------------------------------------ */
    let buffering = false;
    let lastDrawnIndex = -1;
    const ctx = canvas.getContext("2d");

    const frameIndexFor = (p) => Math.round(timeFraction(p) * (FRAME_COUNT - 1));

    // Walks outward from the target for the nearest frame actually
    // loaded, so a not-yet-arrived frame holds the last real picture
    // instead of blanking — same idea as the old video's bufferedCeiling.
    const nearestLoaded = (target) => {
      for (let d = 0; d < FRAME_COUNT; d++) {
        const back = target - d;
        if (back >= 0 && frames[back].loaded) return back;
        const fwd = target + d;
        if (fwd < FRAME_COUNT && frames[fwd].loaded) return fwd;
      }
      return -1;
    };

    // Drawing a loaded frame is synchronous, so this is always settled by
    // the time it returns — the only thing left to wait for is a still-
    // missing image, and its own onload wakes the loop again.
    const renderFrame = (p) => {
      const target = frameIndexFor(p);
      const ready = frames[target].loaded;
      const idx = ready ? target : nearestLoaded(target);
      if (!ready !== buffering) {
        buffering = !ready;
        cinema.classList.toggle("is-buffering", buffering);
      }
      if (idx !== -1 && idx !== lastDrawnIndex) {
        lastDrawnIndex = idx;
        ctx.drawImage(frames[idx].img, 0, 0, FRAME_W, FRAME_H);
        canvas.dataset.frameTime = (idx / FPS).toFixed(3); // test hook
      }
      return true;
    };

    /* ---- chapter transitions ------------------------------------------
       Each chapter fades in as the scroll approaches its slice of the
       timeline and out as it leaves, with a short overlap so the two
       cross rather than blink. Because everything is derived from the
       progress value alone, scrolling back up replays it in reverse.
    -------------------------------------------------------------------- */
    const PRE = 0.16;
    const IN = 0.24;
    const OUT = 0.22;
    const ramp = (x, a, b) => clamp((x - a) / (b - a), 0, 1);
    const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);

    const paintChapters = (p) => {
      let leadIndex = 0;
      let leadAlpha = -1;

      for (let i = 0; i < chapters.length; i++) {
        const c = chapters[i];
        const t = (p - c.from) / (c.to - c.from);
        // The opening chapter never fades in and the closing one never
        // fades out, so both ends of the track sit at full strength.
        const rise = c.isFirst ? 1 : ramp(t, -PRE, IN);
        const fall = c.isLast ? 1 : ramp(t, 1 + PRE, 1 - OUT);
        const a = ease(Math.min(rise, fall));

        if (a > leadAlpha) {
          leadAlpha = a;
          leadIndex = i;
        }

        const off = a < 0.02;
        const live = a > 0.55;
        if (off !== c.off) {
          c.off = off;
          c.el.classList.toggle("is-off", off);
          c.el.inert = off;
        }
        if (live !== c.live) {
          c.live = live;
          c.el.classList.toggle("is-live", live);
        }
        if (off || Math.abs(a - c.alpha) < 0.002) {
          c.alpha = a;
          continue;
        }
        c.alpha = a;

        const dir = t < 0.5 ? 1 : -1;
        const style = c.el.style;
        style.opacity = a.toFixed(3);
        style.transform =
          "translate3d(0," + (dir * (1 - a) * 26).toFixed(2) + "px,0) scale(" +
          (0.986 + a * 0.014).toFixed(4) + ")";
        // Quantised to half-pixel steps: a fresh radius every frame means a
        // fresh filter render every frame, and at this size the steps are
        // not visible anyway.
        const blur = a > 0.985 ? 0 : Math.round((1 - a) * 3 * 2) / 2;
        const filter = blur > 0 ? "blur(" + blur + "px)" : "none";
        if (filter !== c.filter) {
          c.filter = filter;
          style.filter = filter;
        }
      }
      return leadIndex;
    };

    /* ---- the loop ----------------------------------------------------- */
    let targetP = 0;
    let easedP = 0;
    let targetC = 0;
    let easedC = 0;
    let lastRail = -1;
    let cueHidden = null;
    // Smoothing is a time constant, not a per-frame fraction: a fixed
    // fraction settles in a number of frames, so the same flick trailed for
    // ~0.8s at 60fps and longer on a slower device. Converting dt to an
    // exponential gives the same settle in real time everywhere.
    const EASE_TAU = 55; // ms to cover 63% of the remaining distance
    // Stop when the rest would not be visible: one video frame at 15fps is
    // ~0.0066 of the timeline, so a third of that is already sub-frame, and
    // the pan it leaves behind is a couple of pixels.
    const SETTLE = 0.0015;
    let lastFrameAt = 0;

    // The sticky media is scoped to the hero alone (see css/styles.css),
    // so the film and the chapters now share the exact same range — one
    // measurement covers both.
    const readProgress = () => {
      const scrolled = -cinema.getBoundingClientRect().top;
      const stageH = stage.offsetHeight;
      const heroRange = hero.offsetHeight - stageH;
      const p = heroRange > 0 ? clamp(scrolled / heroRange, 0, 1) : 0;
      return { film: p, chapter: p };
    };

    // The poster is frame one of the film, lock-up and all, so it keeps the
    // opening framing rather than travelling with the camera.
    const setStillPan = () => {
      cinema.style.setProperty("--hero-pan-still", panPercent(0).toFixed(2) + "%");
    };

    // Writing a custom property invalidates style for everything that reads
    // it, even when the value is unchanged, so each write is guarded.
    let lastPan = "";
    let lastZoom = "";
    let lastStageOpacity = "";

    const paint = (film, chapter) => {
      const videoSettled = renderFrame(film);
      const tf = timeFraction(film);

      const pan = panPercent(tf).toFixed(2) + "%";
      if (pan !== lastPan) {
        lastPan = pan;
        cinema.style.setProperty("--hero-pan", pan);
      }
      // A slow dolly-out across the calm opening, so something is always
      // moving even before the footage picks up.
      const zoom = (1 + 0.08 * (1 - ease(ramp(film, 0, 0.35)))).toFixed(4);
      if (zoom !== lastZoom) {
        lastZoom = zoom;
        cinema.style.setProperty("--hero-zoom", zoom);
      }
      // Dissolve the chapters as the philosophy line takes over.
      const stageOpacity = (1 - ramp(chapter, 0.955, 1)).toFixed(3);
      if (stageOpacity !== lastStageOpacity) {
        lastStageOpacity = stageOpacity;
        stage.style.opacity = stageOpacity;
      }

      const lead = paintChapters(chapter);
      if (lead !== lastRail) {
        if (railItems[lastRail]) railItems[lastRail].classList.remove("is-current");
        if (railItems[lead]) railItems[lead].classList.add("is-current");
        lastRail = lead;
      }

      const hideCue = film > 0.03;
      if (hideCue !== cueHidden) {
        cueHidden = hideCue;
        cinema.classList.toggle("is-cue-off", hideCue);
      }
      return videoSettled;
    };

    onScrollTask(() => {
      const now = readProgress();
      targetP = now.film;
      targetC = now.chapter;

      // Ease towards the scroll position so a flick of the wheel plays as a
      // glide rather than a jump, then land on it promptly once the wheel
      // stops. Clamped because a backgrounded tab hands back a huge dt.
      const stamp = performance.now();
      const dt = lastFrameAt ? Math.min(stamp - lastFrameAt, 100) : 16.7;
      lastFrameAt = stamp;
      const k = 1 - Math.exp(-dt / EASE_TAU);

      easedP += (targetP - easedP) * k;
      easedC += (targetC - easedC) * k;
      if (Math.abs(targetP - easedP) < SETTLE) easedP = targetP;
      if (Math.abs(targetC - easedC) < SETTLE) easedC = targetC;
      const videoSettled = paint(easedP, easedC);
      return easedP !== targetP || easedC !== targetC || !videoSettled;
    });

    const invalidate = () => {
      lastFrameAt = 0; // don't carry a stale gap across an idle period
      requestFrame();
    };

    /* ---- lifecycle ----------------------------------------------------- */
    // Frame 0 first (it is also preloaded in the document head), then the
    // rest in order — the browser parallelises the requests on its own.
    frames.forEach((frame, i) => {
      frame.img.decoding = "async";
      frame.img.onload = () => {
        frame.loaded = true;
        if (i === 0) cinema.classList.add("is-video-ready");
        invalidate();
      };
      frame.img.onerror = () => {
        // The poster stays, the copy stays, the scroll still works.
        if (i === 0) {
          cinema.classList.add("is-video-failed");
          cinema.classList.remove("is-buffering");
        }
      };
      frame.img.src = framePath(i);
    });

    let resizeTimer = null;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        setStillPan();
        invalidate();
      }, 160);
    };
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("orientationchange", onResize, { passive: true });

    /* ---- chapter rail navigation ---------------------------------------- */
    hero.querySelectorAll("[data-hero-jump]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const c = chapters[Number(btn.dataset.heroJump)];
        if (!c) return;
        const range = hero.offsetHeight - stage.offsetHeight;
        const mid = c.from + (c.to - c.from) * 0.5;
        window.scrollTo({
          top: cinema.offsetTop + range * mid,
          behavior: motionQuery.matches ? "auto" : "smooth"
        });
      });
    });

    setStillPan();
    invalidate();
  };

  if (heroEl && cinemaEl) initCinematicHero(heroEl, cinemaEl);

  /* ---------- Mobile nav ---------- */
  const menuToggle = document.querySelector(".menu-toggle");
  const mainNav = document.querySelector(".main-nav");
  if (menuToggle && mainNav) {
    menuToggle.addEventListener("click", () => {
      const isOpen = mainNav.classList.toggle("is-open");
      menuToggle.setAttribute("aria-expanded", String(isOpen));
      document.body.style.overflow = isOpen ? "hidden" : "";
      // Don't leave a submenu expanded behind a closed panel.
      if (!isOpen) {
        mainNav.querySelectorAll("[data-nav-item].is-open").forEach((i) => {
          i.classList.remove("is-open");
          const t = i.querySelector("[data-nav-toggle]");
          if (t) t.setAttribute("aria-expanded", "false");
        });
      }
    });
    mainNav.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => {
        mainNav.classList.remove("is-open");
        menuToggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });
  }

  /* ---------- Services dropdown ---------- */
  const navItems = Array.from(document.querySelectorAll("[data-nav-item]"));
  if (navItems.length) {
    const wide = window.matchMedia("(min-width:901px)");
    const hoverable = window.matchMedia("(hover: hover)");

    const setOpen = (item, open) => {
      item.classList.toggle("is-open", open);
      const toggle = item.querySelector("[data-nav-toggle]");
      // Hover opens the panel too, so the state is written here rather than
      // only on click — otherwise aria-expanded would report it as closed.
      if (toggle) toggle.setAttribute("aria-expanded", String(open));
    };
    const closeAll = () => navItems.forEach((i) => setOpen(i, false));

    navItems.forEach((item) => {
      const toggle = item.querySelector("[data-nav-toggle]");
      if (toggle) {
        toggle.addEventListener("click", () => {
          // With a pointer over the item, hover has already opened the panel,
          // so a plain toggle here would close what the user just clicked to
          // open. Under the pointer the button only ever opens; on touch and
          // via the keyboard it toggles.
          const hoverDriven = wide.matches && hoverable.matches && item.matches(":hover");
          const open = hoverDriven || !item.classList.contains("is-open");
          closeAll();
          setOpen(item, open);
        });
      }
      item.addEventListener("mouseenter", () => {
        if (wide.matches && hoverable.matches) setOpen(item, true);
      });
      item.addEventListener("mouseleave", () => {
        // Don't yank the panel away from a keyboard user whose focus is
        // still inside it just because the pointer wandered off.
        if (wide.matches && hoverable.matches && !item.contains(document.activeElement)) {
          setOpen(item, false);
        }
      });
      // The panel is only focusable while open, so tabbing out of its last
      // link is what closes it again.
      item.addEventListener("focusout", (event) => {
        if (!item.contains(event.relatedTarget)) setOpen(item, false);
      });
    });

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      const open = navItems.find((i) => i.classList.contains("is-open"));
      if (!open) return;
      closeAll();
      const toggle = open.querySelector("[data-nav-toggle]");
      if (toggle) toggle.focus();
    });

    document.addEventListener("click", (event) => {
      if (!navItems.some((i) => i.contains(event.target))) closeAll();
    });

    // Switching between the panel and the bar leaves the other layout's
    // state behind, so reset on the breakpoint change.
    wide.addEventListener("change", closeAll);
  }

  /* ---------- Scroll-triggered animations ---------- */
  const animated = document.querySelectorAll("[data-animate]");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    animated.forEach((el) => el.classList.add("is-visible"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -60px 0px" }
    );
    animated.forEach((el) => io.observe(el));
  }

  /* ============================================================
     Carousel — the scroll container is the source of truth.
     Snapping, swiping and arrow keys are native; the buttons and dots
     only read that state back and scroll it, so the carousel still
     works if this script never runs.
     ============================================================ */
  document.querySelectorAll("[data-carousel]").forEach((root) => {
    const viewport = root.querySelector("[data-carousel-viewport]");
    const slides = Array.from(root.querySelectorAll(".carousel-slide"));
    if (!viewport || slides.length < 2) return;

    const prev = root.querySelector("[data-carousel-prev]");
    const next = root.querySelector("[data-carousel-next]");
    const label = root.querySelector("[data-carousel-index]");
    const dots = Array.from(root.querySelectorAll("[data-carousel-dot]"));
    let current = -1;

    // Nearest slide centre to the viewport centre, so a half-finished
    // swipe still reports the slide the reader is actually looking at.
    const activeIndex = () => {
      const mid = viewport.scrollLeft + viewport.clientWidth / 2;
      let best = 0;
      let bestGap = Infinity;
      for (let i = 0; i < slides.length; i++) {
        const gap = Math.abs(slides[i].offsetLeft + slides[i].offsetWidth / 2 - mid);
        if (gap < bestGap) {
          bestGap = gap;
          best = i;
        }
      }
      return best;
    };

    const sync = () => {
      const i = activeIndex();
      if (i === current) return;
      current = i;
      if (label) label.textContent = String(i + 1);
      dots.forEach((d, n) => d.parentElement.classList.toggle("is-current", n === i));
      // At either end the button has nowhere to go; say so rather than
      // leaving a control that silently does nothing.
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === slides.length - 1;
    };

    const goTo = (i) => {
      const target = slides[clamp(i, 0, slides.length - 1)];
      if (!target) return;
      viewport.scrollTo({
        left: target.offsetLeft - (viewport.clientWidth - target.offsetWidth) / 2,
        behavior: motionQuery.matches ? "auto" : "smooth"
      });
    };

    if (prev) prev.addEventListener("click", () => goTo(activeIndex() - 1));
    if (next) next.addEventListener("click", () => goTo(activeIndex() + 1));
    dots.forEach((d, n) => d.addEventListener("click", () => goTo(n)));

    let queued = false;
    viewport.addEventListener("scroll", () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        sync();
      });
    }, { passive: true });
    window.addEventListener("resize", sync, { passive: true });
    sync();
  });

  /* ---------- Gallery filter ---------- */
  const filterBar = document.querySelector(".filter-bar");
  const galleryItems = document.querySelectorAll("[data-category]");
  if (filterBar && galleryItems.length) {
    filterBar.addEventListener("click", (event) => {
      const btn = event.target.closest(".filter-btn");
      if (!btn) return;
      filterBar.querySelectorAll(".filter-btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const filter = btn.dataset.filter;
      galleryItems.forEach((item) => {
        const show = filter === "all" || item.dataset.category === filter;
        item.hidden = !show;
      });
    });
  }

  /* ---------- Lightbox ---------- */
  const lightbox = document.querySelector(".lightbox");
  if (lightbox) {
    const lightboxImg = lightbox.querySelector("img");
    const lightboxCap = lightbox.querySelector(".lightbox-cap");
    const closeBtn = lightbox.querySelector(".lightbox-close");

    const openLightbox = (src, caption) => {
      lightboxImg.src = src;
      lightboxImg.alt = caption || "";
      lightboxCap.textContent = caption || "";
      lightbox.classList.add("is-open");
      document.body.style.overflow = "hidden";
    };
    const closeLightbox = () => {
      lightbox.classList.remove("is-open");
      document.body.style.overflow = "";
      lightboxImg.src = "";
    };

    document.querySelectorAll("[data-lightbox]").forEach((figure) => {
      figure.addEventListener("click", () => {
        const img = figure.querySelector("img");
        const caption = figure.querySelector("figcaption");
        openLightbox(img.dataset.full || img.src, caption ? caption.textContent : img.alt);
      });
    });

    closeBtn.addEventListener("click", closeLightbox);
    lightbox.addEventListener("click", (event) => {
      if (event.target === lightbox) closeLightbox();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeLightbox();
    });
  }

  /* ---------- Contact form (client-side only; no credentials here) ---------- */
  const contactForm = document.getElementById("contact-form");
  if (contactForm) {
    contactForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const status = document.getElementById("contact-form-status");
      if (status) {
        status.textContent =
          "Thanks — this form isn't wired to send yet. Please call or email us directly for now.";
        status.className = "form-status is-error";
      }
    });
  }

  /* ---------- Footer year ---------- */
  document.querySelectorAll("[data-year]").forEach((el) => {
    el.textContent = new Date().getFullYear();
  });

  /* ============================================================
     Page assistant — reads the page's own headings (no fixed list to
     keep in sync per page) and lists them as quick jump-to links.
     ============================================================ */
  const aiFab = document.querySelector(".ai-fab");
  const aiPanel = document.querySelector(".ai-fab-panel");
  if (aiFab && aiPanel) {
    const list = aiPanel.querySelector(".ai-fab-list");
    const closeBtn = aiPanel.querySelector(".ai-fab-close");

    const headings = [];
    const pageH1 = document.querySelector(".page-hero h1");
    if (pageH1) headings.push(pageH1);
    document.querySelectorAll(".section-title").forEach((el) => headings.push(el));

    headings.forEach((heading) => {
      const text = heading.textContent.trim().replace(/\s+/g, " ");
      if (!text) return;
      const target = heading.closest("section, .page-hero") || heading;
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = text;
      btn.addEventListener("click", () => {
        setOpen(false);
        target.scrollIntoView({ behavior: motionQuery.matches ? "auto" : "smooth", block: "start" });
      });
      li.appendChild(btn);
      list.appendChild(li);
    });
    if (!headings.length) {
      const p = document.createElement("p");
      p.className = "ai-fab-empty";
      p.textContent = "Nothing to jump to on this page yet.";
      list.appendChild(p);
    }

    const setOpen = (open) => {
      aiFab.setAttribute("aria-expanded", String(open));
      aiPanel.hidden = !open;
      if (open) {
        const first = list.querySelector("button");
        if (first) first.focus();
      } else {
        aiFab.focus();
      }
    };

    aiFab.addEventListener("click", () => setOpen(aiFab.getAttribute("aria-expanded") !== "true"));
    if (closeBtn) closeBtn.addEventListener("click", () => setOpen(false));
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && aiFab.getAttribute("aria-expanded") === "true") setOpen(false);
    });
    document.addEventListener("click", (event) => {
      if (aiFab.getAttribute("aria-expanded") === "true" &&
          !aiPanel.contains(event.target) && event.target !== aiFab) {
        setOpen(false);
      }
    });
  }
})();
