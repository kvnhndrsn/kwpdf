// keywords.js

const DEFAULT_LIST_NAME = "Central Supply-Only";

const DEFAULT_KEYWORD_LISTS = {
    "Central Supply-Only": [
        // --- Geotextiles & Fabrics ---
        "geotextile", "Geotextile", "geo-textile", "geo textile", "geofabric", "geo fabric",
        "geotex", "non woven", "non-woven", "nonwoven", "Monofilament", "textile",
        "synthetic fibre fabric", "filter fabric", "monofilament geotextile", "slit film",
        "needle punched", "heat bonded", "paving fabric", "petromat", "TE-8", "TE-6", "TE-12",

        // --- Geogrids & Soil Reinforcement ---
        "geogrid", "geo grid", "Earth Grid", "gladiator grid", "bi axial", "bi-axial", "biaxial", "triaxial grid",
        "fiberglass grid", "glasgrid", "swamp grid", "Miragrid", "triplanar", "composite grid",
        "composite geo", "strata grid", "TX160", "TX140", "geosynthetic reinforcement",
        "basal reinforcement", "combigrid", "combi grid", "combi-grid",

        // --- Liners & Containment ---
        "geomembrane", "geo membrane", "EPDM liner", "EPDM membrane", "PVC liner",
        "LLDPE liner", "HDPE liner", "20mil RPE", "24mil RPE", "30mil RPE", "RPE liner", "40mil LLDPE", "40mil HDPE", "60mil HDPE",
        "HAZGARD", "XR-5", "XR-3", "GEOFLEX", "secondary containment", "concrete protective liner",
        "Studliner", "Sure-Grip", "Sure Grip", "concrete liner", "CONCRETE LINING SYSTEM",
        "Liner sheet", "ultra grip", "HDPE pipe liner", "ClosureTurf", "BGM", "GCL",
        "BentoGard", "bentonite", "bentoliner", "geosynthetic clay liner", "bentofix",
        "bentomat", "radon", "radon barrier", "vapor barrier", "moisture barrier",
        "stego wrap", "permaseal",

        // --- Drainage & Filtration ---
        "geonet", "geocomposite", "Biplanar", "hydranet", "drainboard", "drainage board",
        "sheet drain", "strip drain", "wick drain", "multiflow", "multi-flow", "multi flow",
        "drain tile", "subdrain", "weeping tile", "drainage tile", "perforated HDPE",
        "HDPE drain pipe", "frenchdrain", "french drain", "high density polyethylene",
        "diameter HDPE", "dual wall", "culvert", "corrugated steel", "CSP", "nyloplast",
        "geopipe", "smooth wall HDPE", "perforated pipe", "advanedge",

        // --- Erosion & Sediment Control ---
        "erosion control", "erosion control blanket", "ErosionControlBlanket", "ECB",
        "TE-SC32", "TE-C32", "stenlog", "wattle", "sediment log", "ditch check", "bio-log",
        "silt fence", "TE100SF", "silt curtain", "sediment control", "turbidity curtain",
        "W315", "safety boom", "coir log", "coconut fiber", "straw wattle", "excelsior blanket",
        "curlex", "north american green", "hydroseeding", "bonded fiber matrix",

        // --- Hard Armor & Shoreline Protection ---
        "cable concrete", "shoreflex", "flexamat", "Concrete Matting", "articulated concrete",
        "articulating concrete", "TRM", "turf reinforcement", "turf-reinforcement", "pyramat",
        "landlok", "Armormax", "Fabrinet", "concrete canvas", "Geosynthetic Cementitious Composite Mat",
        "revetment", "rip rap alternative", "articulating concrete block", "scour protection",

        // --- Stormwater & Cellular Confinement ---
        "geocell", "geo cell", "Geoweb", "Tough Cell", "stormwater system", "storm water system",
        "Stormwater Storage", "StormTank", "soil cell", "aquacell", "r-tank", "eco-rain",
        "permeable pavers", "porous pavement", "baffle curtain",

        // --- Environmental & Dewatering ---
        "coffer dam", "cofferdam", "Aquadam", "Dewatering Bag", "Silt Bag", "Geotube",
        "desludging", "sandbag", "bulk bag", "super sack", "drip pad", "containment berm",

        // --- Walls & Construction Materials ---
        "MSE Wall", "stabilized earth", "reinforced soil", "gabions", "hi-40",
        "foamular 400", "rigid insulation", "detectable warning tile", "warning tile",
        "detectable tile", "detectable warning systems", "ADA tile", "armor-tile",
        "armortile", "armor tile",

        // --- Companies & Manufacturers ---
        "titan enviro", "titan environmental", "mirafi", "tencate", "layfield", "solmax",
        "Propex", "tensar", "NAUE", "armtec", "terrafix", "nilex", "Coletanche", "agru america",

        // --- Testing & Technical Standards ---
        "ASTM D-4632", "ASTM D4632", "ASTM D4491", "ASTM D4751", "ASTM D4533", "ASTM D4833"
    ],
    "Liners": [
        "geomembrane", "geo membrane", "membrane", "EPDM liner", "PVC liner", "LLDPE liner",
        "HDPE liner", "RPE liner", "40mil LLDPE", "40mil HDPE", "60mil HDPE", "HAZGARD",
        "XR-5", "XR-3", "GEOFLEX", "secondary containment", "concrete protective liner",
        "Studliner", "Sure-Grip", "Sure Grip", "concrete liner", "CONCRETE LINING SYSTEM",
        "Liner sheet", "ultra grip", "HDPE pipe liner", "ClosureTurf", "BGM", "GCL",
        "BentoGard", "bentonite", "bentoliner", "geosynthetic clay liner"
    ],
    "Companies": [
        "titan enviro", "titan environmental", "mirafi", "tencate", "layfield", "solmax",
        "Propex", "tensar", "NAUE", "armtec", "terrafix", "nilex", "Coletanche", "agru america"
    ]
};

let KEYWORD_LISTS = { ...DEFAULT_KEYWORD_LISTS };
let DEFAULT_KEYWORDS = KEYWORD_LISTS[DEFAULT_LIST_NAME];

function loadCustomLists() {
    try {
        const saved = localStorage.getItem('tender_custom_lists');
        if (saved) {
            const custom = JSON.parse(saved);
            KEYWORD_LISTS = { ...DEFAULT_KEYWORD_LISTS, ...custom };
        }
    } catch (e) {}
}

function saveCustomLists() {
    const custom = {};
    for (const name of Object.keys(KEYWORD_LISTS)) {
        if (!DEFAULT_KEYWORD_LISTS[name]) {
            custom[name] = KEYWORD_LISTS[name];
        }
    }
    localStorage.setItem('tender_custom_lists', JSON.stringify(custom));
}

function isCustomList(name) {
    return !DEFAULT_KEYWORD_LISTS[name];
}

function createList(name, keywords) {
    KEYWORD_LISTS[name] = keywords;
    saveCustomLists();
    window.KEYWORD_LISTS = KEYWORD_LISTS;
}

function updateList(name, keywords) {
    KEYWORD_LISTS[name] = keywords;
    saveCustomLists();
    window.KEYWORD_LISTS = KEYWORD_LISTS;
}

function deleteList(name) {
    if (!isCustomList(name)) return false;
    delete KEYWORD_LISTS[name];
    saveCustomLists();
    window.KEYWORD_LISTS = KEYWORD_LISTS;
    return true;
}

function switchKeywordList(listName) {
    if (!KEYWORD_LISTS[listName]) return false;
    
    localStorage.setItem('tender_keyword_list', listName);
    window.KEYWORDS = KEYWORD_LISTS[listName];
    localStorage.setItem('tender_keywords', JSON.stringify(window.KEYWORDS));
    
    return true;
}

loadCustomLists();

let saved = localStorage.getItem('tender_keywords');
let savedList = localStorage.getItem('tender_keyword_list');

if (savedList && KEYWORD_LISTS[savedList]) {
    window.KEYWORDS = KEYWORD_LISTS[savedList];
} else {
    window.KEYWORDS = saved ? JSON.parse(saved) : DEFAULT_KEYWORDS;
}

window.KEYWORD_LISTS = KEYWORD_LISTS;
window.DEFAULT_LIST_NAME = DEFAULT_LIST_NAME;
window.isCustomList = isCustomList;
window.createList = createList;
window.updateList = updateList;
window.deleteList = deleteList;
window.populateModalListSelector = populateListSelector;
window.loadListIntoEditor = loadListIntoEditor;
window.showNewListDialog = showNewListDialog;
window.hideNewListDialog = hideNewListDialog;
window.createNewList = createNewList;
window.deleteCurrentList = deleteCurrentList;

function saveKeywords() {
    localStorage.setItem('tender_keywords', JSON.stringify(window.KEYWORDS));
    localStorage.setItem('tender_keyword_list', localStorage.getItem('tender_keyword_list') || DEFAULT_LIST_NAME);
}

function resetKeywords() {
    if(confirm("Reset to original lists?")) {
        localStorage.removeItem('tender_keywords');
        localStorage.removeItem('tender_keyword_list');
        localStorage.removeItem('tender_custom_lists');
        location.reload();
    }
}

function populateListSelector() {
    const listSelector = document.getElementById('listSelector');
    if (!listSelector) return;
    listSelector.innerHTML = '';
    for (const name of Object.keys(KEYWORD_LISTS)) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = `${name} (${KEYWORD_LISTS[name].length})`;
        listSelector.appendChild(opt);
    }
    const savedListName = localStorage.getItem('tender_keyword_list') || DEFAULT_LIST_NAME;
    if (KEYWORD_LISTS[savedListName]) {
        listSelector.value = savedListName;
    }
}

function loadListIntoEditor() {
    const listSelector = document.getElementById('listSelector');
    const listName = listSelector ? listSelector.value : DEFAULT_LIST_NAME;
    const textarea = document.getElementById('keywordInput');
    const deleteBtn = document.getElementById('deleteListBtn');
    const listInfo = document.getElementById('listInfo');
    
    const keywords = KEYWORD_LISTS[listName] || [];
    textarea.value = keywords.join('\n');
    
    if (deleteBtn) {
        deleteBtn.style.display = isCustomList(listName) ? '' : 'none';
    }
    if (listInfo) {
        listInfo.textContent = `${keywords.length} keywords`;
    }
    if (listSelector) {
        listSelector.value = listName;
    }
}

function showNewListDialog() {
    const dialog = document.getElementById('newListDialog');
    if (dialog) dialog.classList.add('show');
    const input = document.getElementById('newListName');
    if (input) {
        input.value = '';
        input.focus();
    }
}

function hideNewListDialog() {
    const dialog = document.getElementById('newListDialog');
    if (dialog) dialog.classList.remove('show');
}

function createNewList() {
    const input = document.getElementById('newListName');
    const name = input.value.trim();
    if (!name) return;
    if (KEYWORD_LISTS[name]) {
        alert('A list with this name already exists.');
        return;
    }
    createList(name, []);
    hideNewListDialog();
    populateListSelector();
    const listSelector = document.getElementById('listSelector');
    if (listSelector) listSelector.value = name;
    loadListIntoEditor();
}

function deleteCurrentList() {
    const listSelector = document.getElementById('listSelector');
    const listName = listSelector ? listSelector.value : '';
    if (!listName || !isCustomList(listName)) return;
    if (!confirm(`Delete list "${listName}"?`)) return;
    deleteList(listName);
    populateListSelector();
    loadListIntoEditor();
}

function saveCurrentList() {
    const listSelector = document.getElementById('listSelector');
    const listName = listSelector ? listSelector.value : DEFAULT_LIST_NAME;
    const textarea = document.getElementById('keywordInput');

    const lines = textarea.value.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);

    updateList(listName, lines);
    switchKeywordList(listName);

    toggleKeywordManager();

    if (typeof performSearch === 'function') {
        performSearch();
    }
}
