import axios from 'axios';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const email = process.env.EMAIL;
const password = process.env.PASSWORD;
const saveDirectory = process.env.SAVE_DIRECTORY;
const blinkAPIServerProd = process.env.BLINK_API_SERVER;

if (!email || !password || !saveDirectory || !blinkAPIServerProd) {
  console.error('Please set EMAIL, PASSWORD, SAVE_DIRECTORY, and BLINK_API_SERVER .env file.');
  process.exit(1);
}

if (email === "X" || password === "X" || saveDirectory === "X") {
  console.error('Please set your email, password, and save directory in the .env file.');
  process.exit(1);
}

function askPin() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('Input PIN: ', (pin) => {
      rl.close();
      resolve(pin);
    });
  });
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function downloadFile(url, dest, headers) {
  if (fs.existsSync(dest)) {
    console.log(`Skipping existing file: ${dest}`);
    return;
  }
  console.log(`Downloading: ${dest}`);
  const writer = fs.createWriteStream(dest);
  try {
    const response = await axios({
      url,
      method: 'GET',
      headers,
      responseType: 'stream',
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (e) {
    console.error(`Error downloading ${url}: ${e.message}`);
  }
}

async function main() {
  if (email === "Your Email Here" || password === "Your Password Here") {
    console.error('Please set your email and password in the script.');
    process.exit(1);
  }

  console.log('Authenticating with Blink API...');

  let loginResp;
  try {
    loginResp = await axios.post(
      `https://${blinkAPIServerProd}/api/v5/account/login`,
      {
        email,
        password,
        unique_id: "00000000-1111-0000-1111-00000000000",
      },
      {
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (e) {
    console.error("Invalid credentials or network error:", e.message);
    process.exit(1);
  }

  const response = loginResp.data;
  console.log('Authenticated. Please check your email or SMS for the PIN.');

  const region = response.account.tier;
  const authToken = response.auth.token;
  const accountID = response.account.account_id;
  const clientID = response.account.client_id;

  const pin = await askPin();

  const pinUri = `https://rest-${region}.immedia-semi.com/api/v4/account/${accountID}/client/${clientID}/pin/verify`;

  try {
    await axios.post(
      pinUri,
      { pin },
      {
        headers: {
          "CONTENT-TYPE": "application/json",
          "TOKEN-AUTH": authToken,
        },
      }
    );
    console.log('PIN verified successfully.');
  } catch (e) {
    console.error("Invalid PIN or verification failed. Please try again.");
    process.exit(1);
  }

  const headers = {
    "TOKEN_AUTH": authToken,
  };

  while (true) {
    console.log("Starting download cycle...");

    const usageUri = `https://rest-${region}.immedia-semi.com/api/v1/camera/usage`;

    let networks;
    try {
      const usageResp = await axios.get(usageUri, { headers });
      networks = usageResp.data.networks;
    } catch (e) {
      console.error("Error fetching networks:", e.message);
      await sleep(10000);
      continue;
    }

    for (const network of networks) {
      const networkId = network.network_id;
      const networkName = network.name;

      for (const camera of network.cameras) {
        const cameraName = camera.name;
        const cameraId = camera.id;

        const cameraUri = `https://rest-${region}.immedia-semi.com/network/${networkId}/camera/${cameraId}`;
        let cameraData;
        try {
          const camResp = await axios.get(cameraUri, { headers });
          cameraData = camResp.data;
        } catch (e) {
          console.error(`Error fetching camera data for ${cameraName}:`, e.message);
          continue;
        }

        const cameraThumbnail = cameraData.camera_status.thumbnail;

        const cameraPath = path.join(saveDirectory, "Blink", networkName, cameraName);
        ensureDirSync(cameraPath);

        const thumbURL = `https://rest-${region}.immedia-semi.com${cameraThumbnail}.jpg`;
        const thumbFileName = "thumbnail_" + path.basename(cameraThumbnail) + ".jpg";
        const thumbPath = path.join(cameraPath, thumbFileName);
        await downloadFile(thumbURL, thumbPath, headers);
      }
    }

    let pageNum = 1;
    while (true) {
      const videosUri = `https://rest-${region}.immedia-semi.com/api/v1/accounts/${accountID}/media/changed?since=2015-04-19T23:11:20+0000&page=${pageNum}`;

      let videosResp;
      try {
        videosResp = await axios.get(videosUri, { headers });
      } catch (e) {
        console.error(`Error fetching videos page ${pageNum}:`, e.message);
        break;
      }

      const media = videosResp.data.media;
      if (!media || media.length === 0) break;

      for (const video of media) {
        if (video.deleted === "True") continue;

        const videoURL = `https://rest-${region}.immedia-semi.com${video.media}`;
        const videoTime = new Date(video.created_at).toISOString().replace(/:/g, '-').replace(/\..+/, '');
        const network = video.network_name;
        const camera = video.device_name;

        const videoFolder = path.join(saveDirectory, "Blink", network, camera);
        ensureDirSync(videoFolder);

        const videoPath = path.join(videoFolder, `${videoTime}.mp4`);

        await downloadFile(videoURL, videoPath, headers);
      }

      pageNum += 1;
    }

    console.log(`All new videos and thumbnails downloaded to ${saveDirectory}Blink/`);
    console.log("Sleeping for 30 minutes before next run...");
    await sleep(30 * 60 * 1000);
  }
}

main().catch(e => {
  console.error("Fatal error:", e);
  process.exit(1);
});
