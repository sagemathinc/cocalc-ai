In the meantime I think it'll be a nontrivial amount of work to come up with a good spec for 

- student pay
- domain memberships
- instructor paying for a class, 
- etc.

GOALS:

- leverage cleanly what we have ALREADY implemented around memberships and throttling:
  - various local and global quotas on storage, number of projects, egress, AI usage, etc.
  - don't try to come up with any model that causes undue tension with this implementation
- must be EASY for users to understand and use.  This is absolutely critical.     I have come up with several purchasing models over the last 9 years, and I don't think any are easy.
- our customers (cocalc.com) so far are classrooms/departments/universities, and also indiviuals/researchers/hobbyists.   However, it would be better if our users were more small-medium business, enterprise, etc., and education was more for visibility.  Also, academic researchers and research labs could be good customers and a natural fit.
- cocalc-ai is aimed at technical users who probably don't know who to program well, but have 
- we REALLY want to _grow_ usage with this new product (cocalc-ai).  This would open a lot of other options.

Thoughts:

Obviously, a university-wide arrangement is the easiest thing for instructors/students to use, and also the best for my company:

   - more demonstrated active usage and uptake of cocalc-ai
   - more revenue (university can justify spending more)
However, the best way to get to a university-wide license in some cases is to have single class or department use cocalc.  How can we do that given that the membership can't be determined by just the email
domain. 

Ideas:

   - We could sell a class membership package.
   - It's for "n students".
   - Instructor associates it with the class
   - When students get added to the course they are also recorded in the membership package.