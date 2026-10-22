Drop one or two days of real marketplace files here, per platform:

- samples/flipkart/  — invoice PDF, settlement Excel, return-created Excel, return-closure Excel
- samples/meesho/    — invoice PDF, payment Excel, return-created Excel, return-closure Excel

Two consecutive days that overlap are ideal: the golden tests check that importing
day 1 then day 2 gives the same result as importing their union.

Everything except this README is gitignored.
