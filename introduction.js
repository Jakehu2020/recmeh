if (localStorage.getItem("hasSeenIntro") === "true") {
    console.log("User has already seen the introduction. Skipping...");
} else {
    localStorage.setItem("hasSeenIntro", "true");
    const driver = window.driver.js.driver;

    const driverObj = driver({
        showProgress: true,
        steps: [
            {
                element: ".previews",
                popover: {
                    title: "Screens",
                    description: "Your camera/recording screen will be displayed here."
                }
            },
            { element: '#btn-pip', popover: { title: 'Picture-in-picture', description: 'Click here to pop out your camera screen' } },
            { element: '#btn-export', popover: { title: 'Export your recordings', description: 'When you\'re done recording, click here to export your recordings into a snapshot. Note that this does NOT end your recording.' } },
            { element: '#export-section', popover: { title: 'Exported snapshots', description: 'Your exported snapshot will appear here. Click the download links to save it! (when they appear)' } },
            { element: '#btn-start', popover: { title: 'Start Recording', description: 'Click here to start recording your timelapse session!' } },
        ]
    });

    driverObj.drive();
}