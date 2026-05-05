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
  personal: string[];
  position: string;
  positionTimeframe: string;
  role: string[];
  slug: string;
  socialLinks?: TeamSocialLinks;
  summary: string;
  title: string;
  website?: { href: string; label: string };
}

export const TEAM_MEMBERS: TeamMemberProfile[] = [
  {
    slug: "william-stein",
    name: "William Stein",
    title: "Founder and CEO",
    position: "Chief Executive Officer and Founder of SageMath, Inc.",
    positionTimeframe: "2015-present",
    email: "wstein@sagemath.com",
    imageSrc: "/public/about/william-stein.png",
    imageAlt: "William Stein with his dog, Bella.",
    bioTopText: [
      "William is both the CEO and a lead software developer for both the front and back end of CoCalc. His involvement with SageMath development is a testament to his dedication and commitment. His remarkable past career, including a tenure as Professor of Mathematics at the University of Washington, adds depth to his leadership.",
      "In his role as CEO of SageMath, Inc., William is at the helm, navigating the future of CoCalc. His responsibilities span delegating tasks, driving profitability, and managing the company's overall growth strategy. In addition, he maintains a close eye on developments within the cloud-based software industry, assesses company risks to ensure they're minimized, and ensures that CoCalc remains stable and productive.",
    ],
    cardText:
      "Get to know the math prodigy behind CoCalc and SageMath, Inc.: William Stein. A Berkeley graduate and an ardent mathematician with over 15 years of experience in teaching and research, William's passion for number theory and computational science has led him down a remarkable path.",
    summary:
      "Founder of SageMath and CoCalc, leading product direction, engineering, and long-term strategy across the entire company.",
    role: [
      "William is both the CEO and a lead software developer across the front and back end of CoCalc, with day-to-day involvement in product direction and engineering decisions.",
      "His long history with SageMath and his years as a professor of mathematics shape CoCalc's emphasis on serious technical computing, teaching, collaboration, and open infrastructure.",
    ],
    personal: [
      "As CEO, William steers growth strategy, delegates across the company, watches technical and business risk closely, and pushes CoCalc toward ambitious but practical new capabilities.",
      "Outside work, he still has the same hands-on interest in mathematics, software, snow, ramps, and open systems that led him to build SageMath and then CoCalc in the first place.",
    ],
    background: [
      'William\'s academic journey began at the University of California, Berkeley, where he dedicated immense time and energy to using closed-source software like Magma for in-depth analysis and research. Though an admirer of its powerful underlying algorithms, William yearned for more transparent software that didn\'t operate as a "black box." His wish to understand "how things operate under the hood" eventually led him to develop SageMath during his time as Assistant Professor of Mathematics at Harvard.',
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
        timeframe: "2006-2019",
      },
      {
        institution: "University of California San Diego",
        position: "Tenured Associate Professor of Mathematics",
        timeframe: "2006-2019",
      },
      {
        institution: "SageMath Open-Source Software",
        position: "Author",
        timeframe: "2004",
      },
      {
        institution: "Harvard University",
        position: "Assistant Professor of Mathematics",
        timeframe: "2000-2005",
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
    position: "Chief Sales Officer at SageMath, Inc.",
    positionTimeframe: "2022-present",
    email: "blaec@cocalc.com",
    imageSrc: "/public/about/blaec-bejarano.png",
    imageAlt: "A portrait of Blaec Bejarano.",
    bioTopText: [
      "If you would like to discuss computational applied mathematics, software development or integration opportunities, or possible partnerships with SageMath, don't hesitate to get in touch with Blaec.",
      "Blaec is passionate about implementing data-driven decision-making in government, industry, and academia and his advocacy exemplifies his research interests - applied mathematics and numerical modeling of geophysical phenomena.",
      "His dedication to academic communities is evident through his past roles, notably as the Student Chapter Secretary of the Society of Industrial and Applied Mathematics. Now, it's hard to even name a community he's not involved in after participating in 30 conferences during 2023.",
    ],
    cardText:
      "As a 2021 graduate from Oregon State University with an M.S. in Mathematics, Blaec uniquely combines advanced mathematical modeling skills with a thriving energy for mountain climbing and music. His academic expertise focuses on applying numerical analysis and partial differential equations to model physical phenomena.",
    summary:
      "CSO at SageMath, Inc., focused on partnerships, outreach, technical demos, and growth.",
    role: [
      "Blaec leads sales and partnership work, helping institutions and technical teams understand how CoCalc fits into their workflows through demos, conversations, and technical translation.",
      "He combines applied mathematics, teaching experience, and active community engagement with a strong focus on product communication and growth.",
    ],
    personal: [
      "Blaec is active in academic, startup, and technical communities and spends a remarkable amount of time presenting, traveling, and building relationships around open technical tools.",
      "Outside work he is also a mountain climber and musician, which fits the same energy and range that he brings to SageMath, Inc.",
    ],
    background: [
      "Graduating in 2021 with an M.S. in Mathematics from Oregon State University, Blaec's academic expertise are focused on applying numerical analysis and partial differential equations to model physical phenomena.",
      "Blaec's foundation in modern teaching methods - gained through his years as a teaching assistant and instructor - complements his current role at SageMath, where his responsibilities span from increasing CoCalc's user base through innovative market penetration strategies to social media and advertising campaigns. Moreover, Blaec drives opportunities for CoCalc by demonstrating the platform's most recent features via live demos at premier conferences like the International Congress on Industrial and Applied Mathematics (ICIAM) and the International Conference on Machine Learning (ICML).",
      "Beyond academic spheres, Blaec is actively engaged in several industry and business societies, including the Seattle Chamber of Commerce, the National Small Business Association Leadership Technology Council, and open-source technology and startup communities like NumFocus and Startup Grind. Blaec directs corporate alliances among his many roles, leading the bid to fuse other proprietary software like MATLAB into the open-source ecosystem.",
      "Even amidst his busy schedule, Blaec finds time for adventure and creativity. Lovingly known as one of the SageMath resident mountaineers, Blaec often scales the Cascade volcanoes of the Pacific Northwest (and can otherwise be found at home writing songs alongside his cat Fushigi).",
    ],
    experience: [
      {
        institution: "SageMath, Inc.",
        position: "CSO",
        timeframe: "2022-present",
      },
      {
        institution: "Cascade Enrichment",
        position: "Tutor",
        timeframe: "2022",
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
    position: "Chief Technology Officer at SageMath, Inc.",
    positionTimeframe: "2015-present",
    email: "hsy@sagemath.com",
    imageSrc: "/public/about/harald-schilly.jpg",
    imageAlt: "Harald Schilly with his dog.",
    bioTopText: [
      "At SageMath, Inc., Harald assumes the role of a tech torchbearer, evaluating new technologies and implementing various libraries for CoCalc projects. His relentless efforts translate into the seamless front-end and back-end software development and maintenance for Sage and CoCalc alike.",
      "Harald isn't all work, though. He savors his free time by reconnecting with nature and playing maestro in the kitchen, whipping up enticing Italian meals like pasta, pizza, and lasagna. Additionally, he is an enthusiast of Bitcoin and its cryptic brethren.",
      "Reach out to chat more about his projects or for advice on the perfect marinara sauce.",
    ],
    cardText:
      "Harald's life-long dedication to coding, profound knowledge, and dynamic personality have been invaluable in shaping CoCalc's operations and success. Initially a key contributor to the SageMath open-source mathematics software while studying Optimization, Harald now exercises his talent for adopting new technologies and algorithms by consistently pushing CoCalc's capabilities into new and exciting territory.",
    summary:
      "CTO at SageMath, Inc., focused on infrastructure, engineering quality, and the overall technical direction of CoCalc.",
    role: [
      "Harald drives front-end and back-end engineering, Linux operations, deployment infrastructure, and technical evaluation across CoCalc.",
      "He has been a long-time SageMath contributor and brings a rare mix of mathematical background, systems knowledge, and hands-on software engineering.",
    ],
    personal: [
      "Harald enjoys time outdoors, cooking Italian food, and the kind of deep technical curiosity that keeps him evaluating new tools long after the workday is over.",
      "That curiosity shows up in CoCalc as sustained attention to infrastructure, performance, Linux systems, and practical engineering details.",
    ],
    background: [
      "Harald's life-long dedication to coding and his profound knowledge and dynamic personality have been invaluable in shaping CoCalc's operations and success.",
      "A software maestro, Harald discovered his passion for coding in his teenage years, experimenting with QBasic on the Microsoft Disk Operating System and advancing onto Turbo Pascal, Visual Basic, Java, and C, among others.",
      "During his studies in Applied Mathematics with a focus on Optimization, he deepened his understanding of the intricate workings of algorithms. As a result, he embraced Java, Python, and later JavaScript as his go-to coding languages. All the while, Harald became a key contributor to the SageMath open-source mathematics software - a testament to his dedication to broadening the horizons of technology and innovation.",
      "Beyond academia, Harald began crafting software solutions for various industry needs. After obtaining his Master's degree, he embarked on a Ph.D. journey at the University of Vienna while teaching Linux system administration and introducing Python to the undergraduates. Fueled by his passion for industry-relevant solutions, he soon founded his own company.",
      "Fast forward to 2015, Harald became instrumental in CoCalc's ascent. His role demanded in-depth understanding of Software Engineering, Linux administration, system monitoring, and oversight of the entire Kubernetes cluster. Harald's responsibilities didn't just stop there: he managed a towering stack of pre-installed open-source software across all CoCalc projects - a role he fulfills with gusto.",
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
        position: "Mag. rer. nat. Mathematics",
        timeframe: "1999-2012",
      },
      {
        institution: "University of Vienna",
        position: "M.S. Mathematics",
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
    position: "Chief Operations Officer at SageMath, Inc.",
    positionTimeframe: "2023-present",
    email: "andrey@cocalc.com",
    imageSrc: "/public/about/andrey-novoseltsev.jpeg",
    imageAlt: "A portrait of Andrey Novoseltsev smiling.",
    bioTopText: [
      "As Chief Operating Officer, Andrey keeps a keen eye on financial aspects of the company to ensure everything is in order while looking for insights to drive the company's growth. If you need custom quotes and special care for your purchasing orders and invoices, Andrey is always happy to help you!",
      "Apart from his efforts in SageMath, Inc. Andrey is a dedicated father of two adorable daughters and strives to instill in them love for hiking in the mountains (and perhaps even backpacking!). He enjoys learning about global geopolitical perspectives and taking into account wood grain irregularities using hand tools.",
    ],
    cardText:
      "Andrey went through graduate school as a student and then an instructor in Russia, USA, and Canada. With an interest in software development starting with early childhood experience on Soviet ES EVM, he used SageMath extensively both in his Ph.D. research and teaching and now oversees day-to-day operations at SageMath, Inc.",
    summary:
      "COO at SageMath, Inc., combining operations, finance, purchasing support, and deep SageMath experience.",
    role: [
      "Andrey keeps a close eye on the company's financial and operational details, and he is the person many customers work with when custom quotes, purchase orders, or invoices need special attention.",
      "He is also an early SageMath developer and a long-time advocate for using computational tools effectively in teaching.",
    ],
    personal: [
      "Outside work, Andrey is a father, hiker, and someone who can be equally enthusiastic about mathematics, woodworking, and backpacking.",
      "He enjoys learning about global geopolitical perspectives and thinking carefully about practical details, which fits his role in helping instructors and institutions operate smoothly.",
    ],
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
