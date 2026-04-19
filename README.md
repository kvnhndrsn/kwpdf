 # pdfwordjs

Scans a folder or zip of PDFs for a large list of keywords and jump between matches.

<img src="https://codeberg.org/kvnhndrsn/pages/raw/branch/main/projects/pdf.png" height="200" align="middle">

## Install

```
# clone repo 
git clone https://github.com/niveknosredneh/pdfwordjs
cd pdfwordjs/  

# download dependancies 
curl -O https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js
curl -O https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
curl -O https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js

# start python web server and open page
python3 -m http.server 8895 &   
xdg-open http://localhost:8895
```

## Authors

* **Kevin Matthew Henderson**

## Contributors

## License

This project is licensed under the MIT License - see the [LICENSE.md](https://github.com/niveknosredneh/PFSG/blob/master/LICENSE) file for details
