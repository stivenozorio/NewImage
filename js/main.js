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
    const video = cinema.querySelector("[data-hero-video]");
    const stage = hero.querySelector(".hero-stage");
    const railItems = Array.from(hero.querySelectorAll(".hero-rail li"));
    const chapters = Array.from(hero.querySelectorAll("[data-chapter]")).map((el) => ({
      el,
      from: parseFloat(el.dataset.from),
      to: parseFloat(el.dataset.to),
      alpha: -1,
      off: null,
      live: null
    }));

    // Anything that makes the cinematic version a bad idea falls back to
    // the static hero the base CSS already renders.
    const saveData = (navigator.connection && navigator.connection.saveData) === true;
    if (!video || !stage || !chapters.length || reduceMotion || saveData ||
        !video.canPlayType || !video.canPlayType("video/mp4")) {
      return;
    }
    chapters[0].isFirst = true;
    chapters[chapters.length - 1].isLast = true;
    cinema.classList.add("is-cinema");

    /* ---- sources -----------------------------------------------------
       Two encodes, both all-intra so any frame can be decoded on its own:
         wide     — the film cropped to its cinematic band (source rows
                    64–1064 of 1920), which keeps the titles burned into
                    the footage out of frame on landscape screens.
         portrait — the full 9:16 composition, trimmed just before the
                    burned-in end card, for phones held upright.
       `top`/`height` describe each file's slice of the original 1920px
       frame, so the pan maths can talk in source coordinates.
    -------------------------------------------------------------------- */
    // `curve` maps scroll progress to a fraction of the clip's duration.
    // A linear map would spend the first 40% of the scroll on the opening
    // seconds, which carry only 11% of the footage's movement — two screens
    // of scrolling for almost no motion. These tables are built from the
    // clip's measured frame-to-frame movement (65% motion-equalised, 35%
    // linear), so the pace stays roughly even from top to bottom while each
    // chapter still lands on the scene it was written for.
    const SOURCES = {
      wide: {
        src: "/assets/video/hero-wide.mp4", top: 64 / 1920, height: 1000 / 1920, w: 1080, h: 1000,
        curve: [0, 0.2044, 0.2869, 0.3342, 0.376, 0.4152, 0.4517, 0.4881, 0.5246, 0.5665,
                0.6083, 0.6475, 0.6813, 0.7177, 0.7542, 0.7906, 0.8325, 0.869, 0.9054, 0.9419, 1]
      },
      portrait: {
        src: "/assets/video/hero-portrait.mp4", top: 0, height: 1, w: 720, h: 1280,
        curve: [0, 0.2119, 0.309, 0.3648, 0.4077, 0.4475, 0.4874, 0.5208, 0.5574, 0.5908,
                0.6275, 0.6704, 0.7102, 0.75, 0.7867, 0.8201, 0.8535, 0.8901, 0.9236, 0.9634, 1]
      }
    };

    const timeFraction = (p) => {
      const c = SOURCES[mode].curve;
      const x = clamp(p, 0, 1) * (c.length - 1);
      const i = Math.min(Math.floor(x), c.length - 2);
      return c[i] + (c[i + 1] - c[i]) * (x - i);
    };
    const WIDE_RATIO = 1.45;
    let mode = null;

    const applySource = () => {
      const next = window.innerWidth / window.innerHeight >= WIDE_RATIO ? "wide" : "portrait";
      if (next === mode) return false;
      mode = next;
      cinema.classList.remove("is-video-ready");
      video.src = SOURCES[mode].src;
      video.load();
      return true;
    };

    /* ---- the camera -------------------------------------------------
       Where the visible band should sit inside the original frame, as a
       fraction of its height. It opens high (blueprints and dusk sky),
       tilts down into the framing, then lifts to the finished house —
       and never crosses the rows where the film burns in its own titles.
    -------------------------------------------------------------------- */
    const bandCenter = (tf) => {
      if (tf <= 0.45) return 0.219;
      if (tf <= 0.7) return 0.219 + ((tf - 0.45) / 0.25) * (0.39 - 0.219);
      return 0.39 + ((tf - 0.7) / 0.3) * (0.281 - 0.39);
    };

    // `tf` is a fraction of the clip's duration, not of the scroll.
    const panPercent = (tf) => {
      const src = SOURCES[mode];
      const vw = video.videoWidth || src.w;
      const vh = video.videoHeight || src.h;
      const boxW = stage.clientWidth;
      const boxH = stage.clientHeight;
      if (!vw || !vh || !boxW || !boxH) return 50;
      // object-fit: cover, width-constrained is the only case with slack.
      const renderedH = vh * (boxW / vw);
      if (renderedH <= boxH + 1) return 50;
      const visible = boxH / renderedH; // fraction of the file that fits
      const centerInFile = (bandCenter(tf) - src.top) / src.height;
      return clamp((centerInFile - visible / 2) / (1 - visible), 0, 1) * 100;
    };

    /* ---- video scrubbing --------------------------------------------- */
    let buffering = false;

    const seekable = (t) => {
      const b = video.buffered;
      if (!b || !b.length) return false;
      for (let i = 0; i < b.length; i++) {
        if (t >= b.start(i) - 0.02 && t <= b.end(i)) return true;
      }
      return false;
    };
    const bufferedCeiling = (t) => {
      const b = video.buffered;
      let best = 0;
      if (!b) return best;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= t + 0.02) best = Math.max(best, Math.min(t, b.end(i)));
      }
      return best;
    };

    // Returns true once the frame on screen matches the scroll position.
    // The loop keeps running until it does, so a seek that is still in
    // flight when the easing settles still gets its final update.
    const scrub = (p) => {
      const duration = video.duration;
      if (!isFinite(duration) || duration <= 0) return true;
      // The last frame is not addressable at exactly `duration`.
      let t = clamp(timeFraction(p) * duration, 0, duration - 0.05);

      // Asking for a frame that has not downloaded yet blanks the poster,
      // so hold at the edge of what is buffered and say so.
      const ready = seekable(t);
      if (!ready) t = bufferedCeiling(t);
      if (!ready !== buffering) {
        buffering = !ready;
        cinema.classList.toggle("is-buffering", buffering);
      }

      if (Math.abs(video.currentTime - t) < 0.02) return true;
      if (video.seeking) return !ready;
      try {
        // Every frame is a keyframe, so fastSeek lands exactly where asked.
        if (typeof video.fastSeek === "function") video.fastSeek(t);
        else video.currentTime = t;
      } catch (err) {
        /* a seek before the metadata lands is not worth reporting */
      }
      // When we are waiting on the network, let `progress` wake us instead
      // of spinning a frame callback at 60fps.
      return !ready;
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
        style.filter = a > 0.985 ? "none" : "blur(" + ((1 - a) * 4.5).toFixed(2) + "px)";
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
    const EASE_K = 0.16;

    // The film runs for the whole act (hero + the philosophy line that
    // follows); the chapters only run for the hero. Two progress values,
    // one measurement — the wrapper and the hero share a top edge.
    const readProgress = () => {
      const scrolled = -cinema.getBoundingClientRect().top;
      const stageH = stage.offsetHeight;
      const filmRange = cinema.offsetHeight - stageH;
      const heroRange = hero.offsetHeight - stageH;
      return {
        film: filmRange > 0 ? clamp(scrolled / filmRange, 0, 1) : 0,
        chapter: heroRange > 0 ? clamp(scrolled / heroRange, 0, 1) : 0
      };
    };

    // The poster is frame one of the film, lock-up and all, so it keeps the
    // opening framing rather than travelling with the camera.
    const setStillPan = () => {
      cinema.style.setProperty("--hero-pan-still", panPercent(0).toFixed(2) + "%");
    };

    const paint = (film, chapter) => {
      const videoSettled = scrub(film);
      const tf = timeFraction(film);
      cinema.style.setProperty("--hero-pan", panPercent(tf).toFixed(2) + "%");
      // A slow dolly-out across the calm opening, so something is always
      // moving even before the footage picks up.
      const zoom = 1 + 0.08 * (1 - ease(ramp(film, 0, 0.35)));
      cinema.style.setProperty("--hero-zoom", zoom.toFixed(4));
      // Dissolve the chapters as the philosophy line takes over.
      stage.style.opacity = (1 - ramp(chapter, 0.955, 1)).toFixed(3);

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
      // Ease towards the scroll position so a flick of the wheel plays as
      // a glide rather than a jump — and settles exactly on target.
      easedP += (targetP - easedP) * EASE_K;
      easedC += (targetC - easedC) * EASE_K;
      if (Math.abs(targetP - easedP) < 0.0002) easedP = targetP;
      if (Math.abs(targetC - easedC) < 0.0002) easedC = targetC;
      const videoSettled = paint(easedP, easedC);
      return easedP !== targetP || easedC !== targetC || !videoSettled;
    });

    const invalidate = requestFrame;

    /* ---- lifecycle ----------------------------------------------------- */
    video.addEventListener("loadedmetadata", () => {
      setStillPan();
      invalidate();
    });
    video.addEventListener("progress", requestFrame, { passive: true });
    video.addEventListener("seeked", requestFrame, { passive: true });
    video.addEventListener("loadeddata", () => {
      cinema.classList.add("is-video-ready");
      // iOS will not paint a frame from a video that has never played, so
      // prime the decoder once and stop again immediately.
      const started = video.play();
      if (started && typeof started.then === "function") {
        started.then(() => video.pause()).catch(() => {});
      } else {
        try { video.pause(); } catch (err) { /* already paused */ }
      }
      invalidate();
    });
    video.addEventListener("error", () => {
      // The poster stays, the copy stays, the scroll still works.
      cinema.classList.add("is-video-failed");
      cinema.classList.remove("is-buffering");
    });

    let resizeTimer = null;
    const onResize = () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        applySource();
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

    applySource();
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
    });
    mainNav.querySelectorAll("a").forEach((a) => {
      a.addEventListener("click", () => {
        mainNav.classList.remove("is-open");
        menuToggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      });
    });
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
})();
