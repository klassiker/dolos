import { default as express, Express, RequestHandler } from "express";
import assert from "assert";
import * as http from "http";
import { CsvPresenter } from "./csvPresenter";
import { Writable } from "stream";
import path from "path";
import { Report } from "../analyze/report";
import { Options } from "../util/options";
import { Diff } from "../analyze/diff";

function respondwithCSV(write: (out: Writable) => void): RequestHandler {
  return ((_req, res) => {
    res.contentType("text/csv");
    res.setHeader("Content-Disposition", "attachment;filename=diffs.csv");
    write(res);
  });
}

export class WebPresenter extends CsvPresenter {

  private diffMap: {[key: number]: Diff} = {};

  constructor(report: Report, options: Options) {
    super(report, options);
    for(const { diff } of report.scoredDiffs) {
      this.diffMap[diff.id] = diff;
    }
  }



  async present(): Promise<void> {
    assert(this.report.scoredDiffs);
    const app: Express = express();

    app.get("/data/metadata.csv", respondwithCSV(o => this.writeMetadata(o)));
    app.get("/data/files.csv", respondwithCSV(o => this.writeFiles(o)));
    app.get("/data/diffs.csv", respondwithCSV(o => this.writeDiffs(o)));
    app.get("/data/kmers.csv", respondwithCSV(o => this.writeKmers(o)));
    app.get("/data/blocks/:id.json", ((req, res) => {
      const id = +req.params.id;
      if (!Object.keys(this.diffMap).includes(id.toString())) {
        res.status(404);
        res.send("Blocks not found for given diff id");
      } else {
        res.contentType("text/json");
        res.setHeader("Content-Disposition", "attachment;filename=blocks.csv");
        this.writeBlocks(res, this.diffMap[+req.params.id]);
        res.end();
      }
    }));

    app.use(express.static(path.join(__dirname, "..", "..", "..", "..", "web", "dist")));

    return this.run(app);
  }

  async run(app: Express): Promise<void> {
    const server = http.createServer(app);
    const serverStarted: Promise<void> = new Promise((r, e) => {
      server.on("listening", r);
      server.on("error", e);
    });
    const serverStopped: Promise<void> = new Promise((r, e) => {
      server.on("close", r);
      server.on("error", e);
    });

    server.listen(this.options.localPort, "localhost");

    await serverStarted;
    console.log(`Dolos is available on http://localhost:${ this.options.localPort }`);
    console.log("Press Ctrl-C to exit.");

    return serverStopped;
  }


}