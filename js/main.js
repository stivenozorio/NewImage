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
  if (header) {
    let lastScrolled = null;
    let lastOverHero = null;
    onScrollTask(() => {
      // Over a cinematic hero the header stays weightless until the film
      // is nearly done; elsewhere it solidifies as soon as you move.
      const heroEnd = heroEl ? heroEl.offsetTop + heroEl.offsetHeight : 0;
      const y = window.scrollY;
      const overHero = heroEl ? y < heroEnd - window.innerHeight * 0.55 : false;
      const scrolled = overHero ? false : y > (heroEl ? heroEnd - window.innerHeight : 40);
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
  const initCinematicHero = (hero) => {
    const video = hero.querySelector("[data-hero-video]");
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
    hero.classList.add("is-cinema");

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
    const SOURCES = {
      wide: { src: "/assets/video/hero-wide.mp4", top: 64 / 1920, height: 1000 / 1920, w: 1080, h: 1000 },
      portrait: { src: "/assets/video/hero-portrait.mp4", top: 0, height: 1, w: 720, h: 1280 }
    };
    const WIDE_RATIO = 1.45;
    let mode = null;

    const applySource = () => {
      const next = window.innerWidth / window.innerHeight >= WIDE_RATIO ? "wide" : "portrait";
      if (next === mode) return false;
      mode = next;
      hero.classList.remove("is-video-ready");
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
    const bandCenter = (p) => {
      if (p <= 0.45) return 0.219;
      if (p <= 0.7) return 0.219 + ((p - 0.45) / 0.25) * (0.39 - 0.219);
      return 0.39 + ((p - 0.7) / 0.3) * (0.281 - 0.39);
    };

    const panPercent = (p) => {
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
      const centerInFile = (bandCenter(p) - src.top) / src.height;
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
      let t = clamp(p * duration, 0, duration - 0.05);

      // Asking for a frame that has not downloaded yet blanks the poster,
      // so hold at the edge of what is buffered and say so.
      const ready = seekable(t);
      if (!ready) t = bufferedCeiling(t);
      if (!ready !== buffering) {
        buffering = !ready;
        hero.classList.toggle("is-buffering", buffering);
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
    let lastRail = -1;
    let cueHidden = null;
    const EASE_K = 0.16;

    const readProgress = () => {
      const range = hero.offsetHeight - stage.offsetHeight;
      if (range <= 0) return 0;
      return clamp(-hero.getBoundingClientRect().top / range, 0, 1);
    };

    // The poster is frame one of the film, lock-up and all, so it keeps the
    // opening framing rather than travelling with the camera.
    const setStillPan = () => {
      hero.style.setProperty("--hero-pan-still", panPercent(0).toFixed(2) + "%");
    };

    const paint = (p) => {
      const videoSettled = scrub(p);
      hero.style.setProperty("--hero-pan", panPercent(p).toFixed(2) + "%");

      const lead = paintChapters(p);
      if (lead !== lastRail) {
        if (railItems[lastRail]) railItems[lastRail].classList.remove("is-current");
        if (railItems[lead]) railItems[lead].classList.add("is-current");
        lastRail = lead;
      }

      const hideCue = p > 0.03;
      if (hideCue !== cueHidden) {
        cueHidden = hideCue;
        hero.classList.toggle("is-cue-off", hideCue);
      }
      return videoSettled;
    };

    onScrollTask(() => {
      targetP = readProgress();
      // Ease towards the scroll position so a flick of the wheel plays as
      // a glide rather than a jump — and settles exactly on target.
      easedP += (targetP - easedP) * EASE_K;
      if (Math.abs(targetP - easedP) < 0.0002) easedP = targetP;
      const videoSettled = paint(easedP);
      return easedP !== targetP || !videoSettled;
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
      hero.classList.add("is-video-ready");
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
      hero.classList.add("is-video-failed");
      hero.classList.remove("is-buffering");
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
          top: hero.offsetTop + range * mid,
          behavior: motionQuery.matches ? "auto" : "smooth"
        });
      });
    });

    applySource();
    setStillPan();
    invalidate();
  };

  if (heroEl) initCinematicHero(heroEl);

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
