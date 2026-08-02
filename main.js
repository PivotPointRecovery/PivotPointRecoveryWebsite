document.addEventListener('DOMContentLoaded', () => {
  const nav = document.getElementById('nav');
  if (nav) {
    // If the nav starts with 'scrolled' (inner pages with light backgrounds), keep it always
    const alwaysScrolled = nav.classList.contains('scrolled');
    if (!alwaysScrolled) {
      const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 50);
      window.addEventListener('scroll', onScroll, { passive: true });
      onScroll();
    }
  }

  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', () => {
      links.classList.toggle('open');
      const spans = toggle.querySelectorAll('span');
      const isOpen = links.classList.contains('open');
      spans[0].style.transform = isOpen ? 'rotate(45deg) translate(5px, 5px)' : '';
      spans[1].style.opacity = isOpen ? '0' : '';
      spans[2].style.transform = isOpen ? 'rotate(-45deg) translate(5px, -5px)' : '';
    });
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => {
      links.classList.remove('open');
      toggle.querySelectorAll('span').forEach(s => { s.style.transform = ''; s.style.opacity = ''; });
    }));
  }

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('revealed'); observer.unobserve(entry.target); }
    });
  }, { threshold: 0.08, rootMargin: '0px 0px -30px 0px' });

  document.querySelectorAll('.image-card, .service-card, .involve-card, .team-card, .service-detail, .split-image, .split-content, .impact-item, .check-item, .volunteer-form-header, .volunteer-form-section .contact-form').forEach(el => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(24px)';
    el.style.transition = 'opacity 0.7s cubic-bezier(0.22, 1, 0.36, 1), transform 0.7s cubic-bezier(0.22, 1, 0.36, 1)';
    observer.observe(el);
  });

  document.querySelectorAll('.services-grid, .team-grid, .involve-cards, .card-row, .impact-items, .check-list').forEach(grid => {
    Array.from(grid.children).forEach((item, i) => { item.style.transitionDelay = `${i * 0.08}s`; });
  });
});
const s = document.createElement('style');
s.textContent = '.revealed{opacity:1!important;transform:translateY(0)!important}';
document.head.appendChild(s);
