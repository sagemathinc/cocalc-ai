/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export interface TeamExperience {
  institution: string;
  position: string;
  timeframe: string;
}

export interface TeamSocialLinks {
  facebook?: string;
  github?: string;
  instagram?: string;
  linkedin?: string;
  twitter?: string;
  youtube?: string;
}

export interface TeamMemberProfile {
  background: string[];
  bioTopText: string[];
  cardText: string;
  email: string;
  experience: TeamExperience[];
  imageAlt: string;
  imageSrc: string;
  name: string;
  slug: string;
  socialLinks?: TeamSocialLinks;
  title: string;
  website?: { href: string; label: string };
}

export const TEAM_MEMBERS: TeamMemberProfile[] = [
  {
    slug: "william-stein",
    name: "William Stein",
    title: "Founder and CEO",
    email: "wstein@sagemath.com",
    imageSrc: "/public/about/william-stein.png",
    imageAlt: "William Stein with his dog, Bella.",
    bioTopText: [
      "William is both the CEO and a lead software developer across the front and back end of CoCalc, with day-to-day involvement in product direction and engineering decisions.",
      "His long history with SageMath and his years as a professor of mathematics shape CoCalc's emphasis on technical computing, collaboration, open infrastructure, and teaching.",
    ],
    cardText:
      "William Stein is the founder of CoCalc and SageMath, Inc. A Berkeley-trained mathematician with over 15 years in teaching and research, his work in number theory and computational science led him from academia to building open tools for technical computing.",
    background: [
      'William\'s academic path began at the University of California, Berkeley, where he relied on closed-source software like Magma for analysis and research. An admirer of its underlying algorithms but wanting software that didn\'t operate as a "black box," he set out to understand "how things work under the hood" — which led him to develop SageMath while an Assistant Professor of Mathematics at Harvard.',
      "April 2013 marked another momentous chapter in William's professional life: he launched SageMathCloud, now known as CoCalc. Inspired by his experiences in the academic and computational fields, this web application was designed to enable the collaborative use of open-source software (while eliminating typical installation and package maintenance issues), thus enhancing the teaching and research process in mathematics and data science. CoCalc now operates under a corporate model, making it self-sufficient and capable of growth independent of grants or other external funding.",
      "William's not all business either. You can catch him making the most of Seattle's famously dismal winters by splitboarding with his Blue Heeler Bella in the Cascades or skating vert at \"the most rad private ramp in Seattle.\"",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "CEO and Founder",
        timeframe: "2015-present",
      },
      {
        institution: "University of Washington",
        position: "Tenured Professor of Mathematics",
        timeframe: "2010-2019",
      },
      {
        institution: "University of Washington",
        position: "Tenured Associate Professor of Mathematics",
        timeframe: "2006-2010",
      },
      {
        institution: "University of California San Diego",
        position: "Tenured Associate Professor of Mathematics",
        timeframe: "2005-2006",
      },
      {
        institution: "SageMath Open-Source Software",
        position: "Author",
        timeframe: "2004",
      },
      {
        institution: "Harvard University",
        position: "Benjamin Peirce Assistant Professor of Mathematics",
        timeframe: "2001-2005",
      },
      {
        institution: "University of California Berkeley",
        position: "Ph.D. in Mathematics",
        timeframe: "2000",
      },
    ],
    socialLinks: {
      facebook: "https://www.facebook.com/william.stein.37",
      github: "https://github.com/sagemathinc/cocalc",
      instagram: "https://www.instagram.com/wstein389/",
      linkedin: "https://www.linkedin.com/in/william-stein-895a26158/",
      twitter: "https://twitter.com/wstein389",
      youtube: "https://www.youtube.com/user/wstein389",
    },
    website: {
      href: "https://wstein.org/",
      label: "Personal website",
    },
  },
  {
    slug: "blaec-bejarano",
    name: "Blaec Bejarano",
    title: "CSO",
    email: "blaec@cocalc.com",
    imageSrc: "/public/about/blaec-bejarano.png",
    imageAlt: "A portrait of Blaec Bejarano.",
    bioTopText: [
      "For partnerships, integrations, or questions about how CoCalc fits a research lab, technical team, or academic institution, Blaec is the person to talk to.",
      "He pairs a background in applied mathematics — numerical modeling of geophysical phenomena — with practical partnership work that helps technical evaluators connect CoCalc to their own workflows.",
      "He stays close to the applied-mathematics and open-source communities, including the Society for Industrial and Applied Mathematics, and represents CoCalc at conferences throughout the year.",
    ],
    cardText:
      "Blaec leads sales and partnerships at SageMath, Inc. He holds an M.S. in Mathematics from Oregon State University, where his work applied numerical analysis and partial differential equations to model physical phenomena — technical grounding he brings to how he helps teams evaluate and adopt CoCalc.",
    background: [
      "Blaec earned his M.S. in Mathematics from Oregon State University in 2021, applying numerical analysis and partial differential equations to model physical phenomena, after teaching there as a graduate assistant and instructor of record.",
      "As Chief Sales Officer at SageMath, Inc., he leads sales, partnerships, and go-to-market, using live demos at conferences such as the International Congress on Industrial and Applied Mathematics (ICIAM) and the International Conference on Machine Learning (ICML) to translate CoCalc's capabilities into concrete adoption paths.",
      "He represents CoCalc across industry and open-source communities — including NumFOCUS, the National Small Business Association Leadership Technology Council, and the Seattle Chamber of Commerce — and leads partnership work that brings tools from proprietary ecosystems such as MATLAB toward open alternatives.",
      "Outside work, Blaec is a mountaineer who climbs the Cascade volcanoes of the Pacific Northwest and a musician who writes songs at home alongside his cat, Fushigi.",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "CSO",
        timeframe: "2022-present",
      },
      {
        institution: "Oregon State University",
        position: "Instructor of Record",
        timeframe: "2019-2021",
      },
      {
        institution: "Oregon State University",
        position: "Graduate Teaching Assistant",
        timeframe: "2018-2021",
      },
      {
        institution: "Oregon State University",
        position: "M.S. Mathematics",
        timeframe: "2018-2021",
      },
      {
        institution: "University of West Florida",
        position: "B.A. History, B.S. Mathematics",
        timeframe: "2013-2017",
      },
    ],
    socialLinks: {
      facebook: "https://www.facebook.com/blaec.bejarano/",
      github: "https://github.com/sagemathinc/cocalc",
      instagram: "https://www.instagram.com/_blaec_/",
      linkedin: "https://www.linkedin.com/in/blaec-bejarano-500966b2/",
      twitter: "https://twitter.com/BlaecBejarano",
      youtube: "https://www.youtube.com/channel/UCoUBZX7c4sMcB3q6MYIW3-Q",
    },
  },
  {
    slug: "harald-schilly",
    name: "Harald Schilly",
    title: "CTO",
    email: "hsy@sagemath.com",
    imageSrc: "/public/about/harald-schilly.jpg",
    imageAlt: "Harald Schilly with his dog.",
    bioTopText: [
      "As CTO of SageMath, Inc., Harald leads front-end development, design, UI work, Linux operations, deployment infrastructure, and technical evaluation across CoCalc.",
      "He has been a long-time SageMath contributor and focuses on the engineering details that keep CoCalc's browser UI and hosted infrastructure reliable.",
      "Reach out to talk about his projects or the engineering behind CoCalc.",
    ],
    cardText:
      "Harald is CoCalc's CTO and a long-time SageMath contributor. He works across front-end development, UI design, Linux operations, deployment infrastructure, and the large open-source software stack available in CoCalc projects.",
    background: [
      "Harald's long experience in software engineering has been central to CoCalc's operations and reliability.",
      "He started programming as a teenager with QBasic on MS-DOS, then moved on to Turbo Pascal, Visual Basic, Java, and C.",
      "During his studies in Applied Mathematics with a focus on Optimization, he deepened his understanding of algorithms and became a key contributor to the SageMath open-source mathematics software.",
      "Beyond academia, Harald built software for industry use. After obtaining his Master's degree, he began Ph.D. work at the University of Vienna while teaching Linux system administration and introducing Python to undergraduates, then founded his own company.",
      "Since 2015, Harald has led much of CoCalc's front-end/UI work, Linux administration, system monitoring, deployment infrastructure, and Kubernetes cluster operations, along with the large stack of pre-installed open-source software available in every CoCalc project.",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "CTO",
        timeframe: "2015-present",
      },
      {
        institution: "Self-employed",
        position: "IT Consultant",
        timeframe: "2015-present",
      },
      {
        institution: "Sage Open-Source Mathematical Software System",
        position: "Developer",
        timeframe: "2007-present",
      },
      {
        institution: "University of Vienna",
        position: "Mathematician, Faculty of Mathematics",
        timeframe: "2006-2014",
      },
      {
        institution: "DAGOPT Optimization Technologies GmbH",
        position: "Research and Development",
        timeframe: "2011-2012",
      },
      {
        institution: "University of Vienna",
        position: "Master's (Mag. rer. nat.) in Mathematics",
        timeframe: "1999-2008",
      },
    ],
    socialLinks: {
      facebook: "https://www.facebook.com/harald.schilly",
      github: "https://github.com/sagemathinc/cocalc",
      instagram: "https://www.instagram.com/ha_sch/",
      linkedin: "https://www.linkedin.com/in/harald-schilly-519b2813/",
      twitter: "https://twitter.com/Ha_Sch",
      youtube: "https://www.youtube.com/c/HaraldSchilly",
    },
  },
  {
    slug: "andrey-novoseltsev",
    name: "Andrey Novoseltsev",
    title: "COO",
    email: "andrey@cocalc.com",
    imageSrc: "/public/about/andrey-novoseltsev.jpeg",
    imageAlt: "A portrait of Andrey Novoseltsev smiling.",
    bioTopText: [
      "As Chief Operating Officer, Andrey keeps a keen eye on financial aspects of the company to ensure everything is in order while looking for insights to drive the company's growth. If you need custom quotes and special care for your purchasing orders and invoices, Andrey is always happy to help you!",
      "Apart from his efforts in SageMath, Inc. Andrey is a dedicated father of two adorable daughters and strives to instill in them love for hiking in the mountains (and perhaps even backpacking!). He enjoys learning about global geopolitical perspectives and taking into account wood grain irregularities using hand tools.",
    ],
    cardText:
      "Andrey went through graduate school as a student and then an instructor in Russia, USA, and Canada. With an interest in software development starting with early childhood experience on Soviet ES EVM, he used SageMath extensively both in his Ph.D. research and teaching and now oversees day-to-day operations at SageMath, Inc.",
    background: [
      "Andrey went through graduate school as a student and then an instructor in Russia, USA, and Canada. With an interest in software development starting with early childhood experience on Soviet ES EVM, he used SageMath extensively both in his Ph.D. research and teaching.",
      "Together with Volker Braun (long term release manager of SageMath), Andrey has implemented a framework for computations with toric varieties and Calabi-Yau varieties in them, fixing various bugs and making improvements in other areas of SageMath along the way.",
      "Andrey was one of the early adopters of SageMathCell and its interacts, writing many of them for courses on differential equations and multivariate calculus. He set up dedicated servers for his classes and when the original lead of SageMathCell (Jason Grout) was switching to other endeavours, it was natural for Andrey to pick up the project.",
      "As another direction of integrating SageMath into teaching, Andrey has developed a module for interactive learning of intricacies of the simplex method in optimization, which eventually grew into supporting group homework assignments and exams for that course. That experience was instrumental in understanding the importance of tools like CoCalc to smoothly support instructors in using Python notebooks for teaching.",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "COO",
        timeframe: "2023-present",
      },
      {
        institution: "Self-Employed",
        position: "Insurance Agent",
        timeframe: "2019-present",
      },
      {
        institution: "SageMath",
        position: "SageMathCell Maintainer and Lead Developer",
        timeframe: "2014-present",
      },
      {
        institution: "SageMath",
        position: "Developer",
        timeframe: "2006-present",
      },
      {
        institution: "University of Alberta",
        position: "Postdoc",
        timeframe: "2011-2016",
      },
      {
        institution: "University of Alberta",
        position: "Ph.D. in Mathematics",
        timeframe: "2011",
      },
    ],
    socialLinks: {
      facebook: "https://www.facebook.com/andrey.novoseltsev.351",
      github: "https://github.com/novoselt",
      instagram: "https://www.instagram.com/anovoselt/",
      linkedin: "https://www.linkedin.com/in/andrey-novoseltsev/",
    },
  },
];

const TEAM_MEMBER_MAP = new Map(
  TEAM_MEMBERS.map((member) => [member.slug, member]),
);

export function getTeamMember(slug?: string): TeamMemberProfile | undefined {
  if (!slug) return;
  return TEAM_MEMBER_MAP.get(slug);
}
