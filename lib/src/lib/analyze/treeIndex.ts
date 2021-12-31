import { IndexInterface } from "./indexInterface";
import { SimpleReport } from "./simpleReport";
import { File } from "../file/file";
import { CustomOptions, Options } from "../util/options";
import { default as Parser, SyntaxNode, Tree } from "tree-sitter";
import { TokenizedFile } from "../file/tokenizedFile";
import { ScoredPairs } from "./reportInterface";
import { SimplePair } from "./simplePair";
import { buildSimpleFragment } from "./simpleFragmentBuilder";
import { SharedFingerprint } from "./sharedFingerprint";

type Hash = number;

export class TreeIndex implements IndexInterface {
  private parser?: Parser;
  // maps a stringified list to the number associated with it
  private readonly listNumber: Map<string, Hash> = new Map();
  // TODO could possibly be removed?
  // maps a root of a (sub)tree to it's size
  private readonly nodeToTreeSize: Map<SyntaxNode, number> = new Map();
  // maps a syntax node to it's amount of children that are not yet processed by the algorithm
  private readonly children: Map<SyntaxNode, number> = new Map();
  // a number, monotonically increases during the execution of the algorithm. If two roots of two sub-trees have the
  // same number assigned to them, then they are isomorphic
  private count: Hash = 0;
  // maps a node to it's number
  private readonly nodeToHash: Map<SyntaxNode, Hash> = new Map();

  constructor(private options: CustomOptions) {}

  private createParser(): Parser {
    try {
      const parser = new Parser();
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const languageModule = require("tree-sitter-" + this.options.language);
      parser.setLanguage(languageModule);
      return parser;
    } catch (error) {
      throw new Error(
        `The module 'tree-sitter-${this.options.language}' could not be found. ` +
          "Try to install it using npm or yarn, but it may not be supported (yet)."
      );
    }
  }

  async compareFiles(files: File[]): Promise<SimpleReport> {

    const nodeMappedToFile: Map<SyntaxNode, TokenizedFile> = new Map();
    const forest: Tree[] = [];

    if(!this.parser){
      this.parser = this.createParser();
    }

    for (const file of files) {
      const tree = this.parser.parse(file.content);
      const tokenizedFile = new TokenizedFile(file, [], []);
      forest.push(tree);

      for (const node of TreeIndex.breadthFirstWalk(tree.rootNode)) {

        nodeMappedToFile.set(node, tokenizedFile);
      }
    }

    console.log("Here");
    this.subTreeIsomorphism(forest);
    console.log("Here2");

    // console.log(this.listNumber);

    // const grouped = this.listNumber.ent
    const hashToNodeList = this.mapHashToNodeList(forest);
    console.log("Here3");

    // nodes that have either already been looked at or it's a root of a subtree to which this node belongs has been
    // accepted
    const [grouped, hashes] = this.groupNodes(forest, hashToNodeList);
    const filteredGroup = this.filterGroups(grouped);
    console.log("Here4");
    const hashToFingerprint = this.mapHashToFingerprint(hashes);
    console.log("Here5");
    const pairs = this.makeScoredPairs(filteredGroup, hashToFingerprint, nodeMappedToFile);
    console.log("Here6");
    const tokenizedFiles = [...new Set(nodeMappedToFile.values())];
    console.log("Here7");
    return new SimpleReport(pairs, new Options(), tokenizedFiles);
  }

  private makeScoredPairs(
    filteredGroup: SyntaxNode[][],
    hashToFingerprint: Map<Hash, SharedFingerprint>,
    nodeMappedToFile: Map<SyntaxNode, TokenizedFile>
  ): Array<ScoredPairs> {
    const pairs: Array<ScoredPairs> = [];
    const pairDict: Map<string, SimplePair> = new Map();
    for (const group of filteredGroup) {
      const hash = this.nodeToHash.get(group[0]) as Hash;
      const fingerprint = hashToFingerprint.get(hash) as SharedFingerprint;
      // console.log("new group");
      for (let i = 0; i < group.length; i += 1) {
        const leftNode = group[i];
        const leftFile = nodeMappedToFile.get(leftNode) as TokenizedFile;
        for (let j = i + 1; j < group.length; j += 1) {
          const rightNode = group[j];
          const rightFile = nodeMappedToFile.get(rightNode) as TokenizedFile;
          const key = this.getKey(leftFile, rightFile);
          let pair;
          if (pairDict.has(key)) {
            pair = pairDict.get(key) as SimplePair;
          } else {
            pair = new SimplePair(
              leftFile,
              rightFile,
              []
            );
            pairDict.set(key, pair);
          }
          const fragment = buildSimpleFragment(leftNode, rightNode, fingerprint);
          pair.fragmentList.push(fragment);
        }
      }
      // console.log("new group");
      // for (const node of group) {
      //   // const pair = new SimplePair()
      //   let str = "\t";
      //   str += `{from: [${node.startPosition.row + 1}, ${node.startPosition.column}]`;
      //   str += `, to: [${node.endPosition.row + 1}, ${node.endPosition.column}]}: => ${nodeMappedToFile.get(node)}`;
      //   console.log(str);
      // }
      // console.log("");
    }

    // console.log(pairDict);
    for (const pair of pairDict.values()) {
      pairs.push({
        pair: pair,
        similarity: 0,
        longest: 0,
        overlap: 0,
      });
    }
    return pairs;
  }

  private mapHashToFingerprint(hashes: Set<Hash>): Map<Hash, SharedFingerprint> {
    const hashToFingerprint: Map<Hash, SharedFingerprint> = new Map();
    for (const hash of hashes.values()) {
      const fingerPrint = new SharedFingerprint(hash, null);
      hashToFingerprint.set(hash, fingerPrint);
    }
    return hashToFingerprint;
  }

  private groupNodes(forest: Tree[], hashToNodeList: Map<Hash, Array<SyntaxNode>>): [SyntaxNode[][], Set<Hash>] {
    const acceptedSet: Set<SyntaxNode> = new Set();
    // matches
    const grouped: SyntaxNode[][] = [];
    const hashes: Set<Hash> = new Set();
    // Has to be breadth first so that parents are always first
    for (const node of TreeIndex.breadthFirstWalkForest(forest)) {
      if (acceptedSet.has(node)) {
        continue;
      }

      const matchedNodes: SyntaxNode[] = hashToNodeList.get(
        this.nodeToHash.get(node) as Hash
      ) as SyntaxNode[];
      hashes.add(this.nodeToHash.get(node) as Hash);

      if (matchedNodes.length > 1) {
        grouped.push(matchedNodes);
        for (const matchedNode of matchedNodes) {
          for (const child of TreeIndex.breadthFirstWalk(matchedNode)) {
            acceptedSet.add(child);
          }
        }
      }
    }
    return [grouped, hashes];
  }

  private mapHashToNodeList(forest: Tree[]): Map<Hash, Array<SyntaxNode>> {
    const numberToNodeList: Map<number, SyntaxNode[]> = new Map();

    for (const node of TreeIndex.breadthFirstWalkForest(forest)) {
      // // leave matches are not useful information
      // if(node.childCount == 0) {
      //   continue;
      // }
      const integer: number = this.nodeToHash.get(node) as number;
      const matchedNodes = numberToNodeList.get(integer);
      if (matchedNodes !== undefined) {
        matchedNodes.push(node);
      } else {
        numberToNodeList.set(integer, [node]);
      }
    }
    return numberToNodeList;
  }

  private subTreeIsomorphism(forest: Tree[]): void {
    const queue: SyntaxNode[] = [];
    for (const syntaxNode of TreeIndex.breadthFirstWalkForest(forest)) {
      this.nodeToTreeSize.set(syntaxNode, 1);
      this.children.set(syntaxNode, syntaxNode.namedChildCount);
      if (syntaxNode.namedChildCount === 0) {
        queue.push(syntaxNode);
      }
    }

    this.count = 0;
    while (queue.length > 0) {
      const node: SyntaxNode = queue.shift() as SyntaxNode;
      this.assignNumberToSubTree(node);
      if (node.parent !== null) {
        const parent: SyntaxNode = node.parent as SyntaxNode;
        const sizeParent: number = this.nodeToTreeSize.get(parent) as number;
        this.nodeToTreeSize.set(parent, sizeParent + (this.nodeToTreeSize.get(node) as number));

        this.children.set(parent, (this.children.get(parent) as number) - 1);
        if ((this.children.get(parent) as number) === 0) {
          queue.push(parent);
        }
      }
    }
  }

  private getKey(file1: TokenizedFile, file2: TokenizedFile): string {
    if(file1.id < file2.id) {
      return [file1.id, file2.id].toString();
    } else {
      return [file2.id, file1.id].toString();
    }

  }

  /**
   * Assigns a number to the subtree rooted at the given node.
   * @param v: The root of the subtree
   * @private
   */
  private assignNumberToSubTree(v: SyntaxNode): void {
    const nodeNumberList = [];
    for (const child of TreeIndex.walkOverChildren(v)) {
      nodeNumberList.push(this.nodeToHash.get(child) as number);
    }
    //TODO use bucket sort
    nodeNumberList.sort((e1, e2) => e1 - e2);

    nodeNumberList.unshift(v.type);
    const listKey = nodeNumberList.toString();
    if (this.listNumber.has(listKey)) {
      this.nodeToHash.set(v, this.listNumber.get(listKey) as number);
    } else {
      this.count += 1;
      this.listNumber.set(listKey, this.count);
      this.nodeToHash.set(v, this.count);
    }
  }


  private static* breadthFirstWalkForest(forest: Tree[]): IterableIterator<SyntaxNode> {
    for (const tree of forest) {
      yield* TreeIndex.breadthFirstWalk(tree.rootNode);
    }
  }

  private static* breadthFirstWalk(rootNode: SyntaxNode): IterableIterator<SyntaxNode> {
    const queue: SyntaxNode[] = [];
    queue.push(rootNode);
    while (queue.length > 0) {
      const node: SyntaxNode = queue.shift() as SyntaxNode;
      yield node;
      for (const child of TreeIndex.walkOverChildren(node)) {
        queue.push(child);
      }
    }
  }

  private static* walkOverChildren(node: SyntaxNode): IterableIterator<SyntaxNode> {
    // const cursor: TreeCursor = node.walk();
    // if (cursor.gotoFirstChild()) {
    //   yield cursor.currentNode;
    //   while (cursor.gotoNextSibling()) {
    //     if(!cursor.currentNode.isNamed) {
    //       continue;
    //     }
    //     yield cursor.currentNode;
    //   }
    // }
    for (const child of node.namedChildren) {
      // console.log(node.type, child.type);
      yield child;
    }
  }

  private filterGroups(grouped: SyntaxNode[][]): SyntaxNode[][] {
    const filteredGroup = grouped.filter(group =>
      group.some(node => node.endPosition.row - node.startPosition.row > 0),
    );
    // for (const group of grouped) {
      // console.log(group.some(node => !node));
      // console.log(
      //   group.length,
      //   group[0].type,
      //   this.nodeToTreeSize.get(group[0]),
      //   group[0].endPosition.row - group[0].startPosition.row
      // );
    // }

    return filteredGroup;
  }
}