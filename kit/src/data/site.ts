// The first file you edit when starting a new client site.
// Every page reads from this object via `import { site } from "../data/site"`.

export const site = {
  name: "Acme Co.",
  tagline: "We do great work for local businesses.",
  phone: "(555) 123-4567",
  email: "hello@acme.example",
  address: "123 Main St, Springfield, USA",

  hours: [
    { day: "Mon – Fri", hours: "8:00 AM – 6:00 PM" },
    { day: "Saturday", hours: "9:00 AM – 2:00 PM" },
    { day: "Sunday", hours: "Closed" },
  ],

  navLinks: [
    { label: "Services", href: "/services" },
    { label: "About", href: "/about" },
    { label: "Contact", href: "/contact" },
  ],

  socials: [
    { label: "Facebook", href: "https://facebook.com/" },
    { label: "Instagram", href: "https://instagram.com/" },
    { label: "Google", href: "https://google.com/" },
  ],

  footerGroups: [
    {
      title: "Company",
      links: [
        { label: "About", href: "/about" },
        { label: "Services", href: "/services" },
        { label: "Contact", href: "/contact" },
      ],
    },
    {
      title: "Services",
      links: [
        { label: "Service One", href: "/services#one" },
        { label: "Service Two", href: "/services#two" },
        { label: "Service Three", href: "/services#three" },
      ],
    },
    {
      title: "Resources",
      links: [
        { label: "FAQs", href: "/#faq" },
        { label: "Reviews", href: "/#testimonials" },
      ],
    },
  ],
} as const;
