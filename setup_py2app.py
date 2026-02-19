from setuptools import setup

APP = ["sensoria_excel_gui.py"]
DATA_FILES = []
OPTIONS = {
    "argv_emulation": False,
    "includes": ["build_modified_excel", "tkinter"],
    "plist": {
        "CFBundleName": "Sensoria Excel Processor",
        "CFBundleDisplayName": "Sensoria Excel Processor",
        "CFBundleIdentifier": "com.sensoria.excelprocessor",
        "CFBundleShortVersionString": "1.0.0",
        "CFBundleVersion": "1.0.0",
        "LSMinimumSystemVersion": "10.13",
    },
}

setup(
    app=APP,
    data_files=DATA_FILES,
    options={"py2app": OPTIONS},
    setup_requires=["py2app"],
)
